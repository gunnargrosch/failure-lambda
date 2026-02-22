declare module "mitm" {
  function Mitm(): Mitm.MitmInstance;

  namespace Mitm {
    interface MitmSocket {
      end(): void;
      bypass(): void;
    }

    interface MitmConnectOpts {
      host?: string;
    }

    interface MitmInstance {
      enable(): void;
      disable(): void;
      on(event: "connect", handler: (socket: MitmSocket, opts: MitmConnectOpts) => void): void;
      removeListener(event: string, handler: (...args: unknown[]) => void): void;
      _events?: Record<string, ((...args: unknown[]) => void) | ((...args: unknown[]) => void)[]>;
    }
  }

  export = Mitm;
}
