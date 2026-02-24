// No failure-lambda import needed — the layer handles everything.
export const handler = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello from Node.js!", runtime: process.version }),
  };
};
