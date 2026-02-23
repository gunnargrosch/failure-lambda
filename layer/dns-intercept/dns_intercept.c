/**
 * LD_PRELOAD library for failure-lambda denylist.
 *
 * Intercepts libc's getaddrinfo() to block DNS resolution for hostnames
 * matching deny patterns. The proxy writes patterns (one POSIX Extended
 * Regular Expression per line) to /tmp/.failure-lambda-denylist. This
 * library reads the file on each getaddrinfo() call, matches the hostname,
 * and returns EAI_NONAME for matches (equivalent to NXDOMAIN).
 *
 * Communication:
 *   proxy writes patterns → /tmp/.failure-lambda-denylist (atomic: tmp+rename)
 *   proxy removes file → denylist deactivated
 *
 * Performance:
 *   When denylist is inactive (no file): single stat() syscall (~1μs).
 *   When active: file read + regex compile per DNS lookup. Acceptable for
 *   a chaos engineering tool where denylist is used for testing.
 *
 * Thread safety:
 *   All state is stack-local (no mutable globals). Multiple threads calling
 *   getaddrinfo concurrently is safe.
 *
 * Runtime coverage:
 *   Works for any runtime using libc's getaddrinfo: Node.js (libuv),
 *   Python (socket), Java (JNI), Rust (tokio). Go's pure Go resolver
 *   bypasses libc — use GODEBUG=netdns=cgo to force the libc resolver.
 *
 * Note: getaddrinfo_a (the glibc async variant) is not intercepted. None
 * of the major Lambda runtimes use it — Node.js/libuv calls the synchronous
 * getaddrinfo in a thread pool, Python and Java use it synchronously via JNI.
 *
 * Failure mode:
 *   If LD_PRELOAD fails to load (glibc version mismatch, etc.), the runtime
 *   starts without interception and denylist silently no-ops. This is the
 *   correct behavior for a chaos tool — fail open, never break production.
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <regex.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#define DENYLIST_PATH "/tmp/.failure-lambda-denylist"
#define MAX_LINE 512

typedef int (*getaddrinfo_fn)(const char *, const char *,
                              const struct addrinfo *,
                              struct addrinfo **);

static getaddrinfo_fn real_getaddrinfo = NULL;

/**
 * Check whether hostname matches any deny pattern in the denylist file.
 * Returns 1 if denied, 0 if allowed or file doesn't exist.
 */
static int is_denied(const char *hostname) {
    /* Fast path: if the file doesn't exist, skip everything. */
    struct stat st;
    if (stat(DENYLIST_PATH, &st) != 0 || st.st_size == 0) {
        return 0;
    }

    FILE *f = fopen(DENYLIST_PATH, "r");
    if (!f) {
        return 0;
    }

    int denied = 0;
    char line[MAX_LINE];

    while (fgets(line, sizeof(line), f) != NULL) {
        /* Strip trailing newline */
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n') {
            line[len - 1] = '\0';
        }
        if (line[0] == '\0') {
            continue;
        }

        regex_t re;
        if (regcomp(&re, line, REG_EXTENDED | REG_NOSUB) == 0) {
            if (regexec(&re, hostname, 0, NULL, 0) == 0) {
                denied = 1;
            }
            regfree(&re);
            if (denied) {
                break;
            }
        }
        /* Invalid regex: skip silently (same as TypeScript library). */
    }

    fclose(f);
    return denied;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints,
                struct addrinfo **res) {
    if (!real_getaddrinfo) {
        real_getaddrinfo = (getaddrinfo_fn)dlsym(RTLD_NEXT, "getaddrinfo");
        if (!real_getaddrinfo) {
            return EAI_SYSTEM;
        }
    }

    if (node != NULL && node[0] != '\0' && is_denied(node)) {
        return EAI_NONAME;
    }

    return real_getaddrinfo(node, service, hints, res);
}
