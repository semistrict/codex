#!/usr/bin/env node

const http = require("node:http");

const port = Number.parseInt(process.argv[2] ?? "8789", 10);

function asHeaderObject(headersArray) {
  if (!Array.isArray(headersArray)) {
    return {};
  }
  return Object.fromEntries(
    headersArray.filter(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    ),
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/http") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  try {
    const payloadText = await readBody(req);
    const payload = JSON.parse(payloadText);
    const method = typeof payload.method === "string" ? payload.method : "GET";
    const url = typeof payload.url === "string" ? payload.url : "";
    if (!url) {
      res.statusCode = 400;
      res.end("missing url");
      return;
    }
    const headers = asHeaderObject(payload.headers);
    const response = await fetch(url, {
      method,
      headers,
      body: typeof payload.body === "string" ? payload.body : undefined,
      redirect: "follow",
    });
    const body = await response.text();
    const serializedHeaders = [...response.headers.entries()].map(
      ([key, value]) => [key, value],
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: response.status,
        headers: serializedHeaders,
        body,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`http proxy listening on http://127.0.0.1:${port}/http`);
});
