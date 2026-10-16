import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function bundledProvider(
  t,
  command,
  { holdAfterTool = false } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deps-bundled-"));
  const requests = [],
    faults = [],
    sockets = new Set();
  let posts = 0;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (bytes) => {
      data += bytes;
      if (Buffer.byteLength(data) > 1048576)
        req.destroy(new Error("Controlled request too large"));
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(503);
        res.end();
        return;
      }
      try {
        const body = JSON.parse(data);
        requests.push(body);
        posts++;
        if (!body.tools.some((tool) => tool.name === "exec_command"))
          throw new Error("Bundled CLI did not advertise exec_command");
        if (posts > 1 && holdAfterTool) return;
        const item =
          posts === 1
            ? {
                id: "fc_1",
                type: "function_call",
                call_id: "call_1",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: command,
                  login: false,
                  max_output_tokens: 2000,
                  yield_time_ms: 10000,
                }),
                status: "completed",
              }
            : {
                id: "msg_2",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Controlled bundled CLI tool completed.",
                    annotations: [],
                  },
                ],
              };
        const response = {
          id: `resp_${posts}`,
          object: "response",
          status: "completed",
          model: "synthetic-offline",
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) {
        faults.push(error.message);
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    requests,
    faults,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    setCommand(value) {
      command = value;
    },
    get posts() {
      return posts;
    },
  };
}
export const nodeCommand = (source) =>
  `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
