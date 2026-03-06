const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "simplebackup-api-test-"));

process.env.UPLOAD_DIR = tempRoot;
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";

const { startServer } = require("../server.js");

const server = startServer({ port: 0, host: "127.0.0.1" });

const getBaseUrl = () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port.");
  }

  return `http://127.0.0.1:${address.port}`;
};

const uploadChunk = async ({ uploadId, chunkIndex, chunkText, filename }) => {
  const form = new FormData();
  form.append("uploadId", uploadId);
  form.append("chunkIndex", `${chunkIndex}`);
  form.append("chunk", new Blob([chunkText]), filename);

  return fetch(`${getBaseUrl()}/upload/chunk`, {
    method: "POST",
    body: form,
  });
};

const closeServer = async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
};

const testChunkedUploadResumeAndFinalize = async () => {
  const filename = "big-backup.bin";
  const content = "abcdefghijklmnopqrstuvwxyz";
  const chunkSize = 8;
  const totalChunks = Math.ceil(content.length / chunkSize);

  const initResponse = await fetch(`${getBaseUrl()}/upload/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      size: content.length,
      chunkSize,
      totalChunks,
      lastModified: 123,
    }),
  });

  assert.equal(initResponse.status, 201);
  const initPayload = await initResponse.json();
  assert.ok(initPayload.uploadId);
  assert.equal(initPayload.totalChunks, totalChunks);

  const firstChunkResponse = await uploadChunk({
    uploadId: initPayload.uploadId,
    chunkIndex: 0,
    chunkText: content.slice(0, chunkSize),
    filename,
  });
  assert.equal(firstChunkResponse.status, 200);

  const statusResponse = await fetch(`${getBaseUrl()}/upload/status/${initPayload.uploadId}`);
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.deepEqual(statusPayload.uploadedChunks, [0]);
  assert.equal(statusPayload.uploadedBytes, chunkSize);

  const incompleteResponse = await fetch(`${getBaseUrl()}/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: initPayload.uploadId }),
  });
  assert.equal(incompleteResponse.status, 409);
  const incompletePayload = await incompleteResponse.json();
  assert.deepEqual(incompletePayload.missingChunks, [1, 2, 3]);

  for (let chunkIndex = 1; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkResponse = await uploadChunk({
      uploadId: initPayload.uploadId,
      chunkIndex,
      chunkText: content.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
      filename,
    });
    assert.equal(chunkResponse.status, 200);
  }

  const completeResponse = await fetch(`${getBaseUrl()}/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: initPayload.uploadId }),
  });

  assert.equal(completeResponse.status, 200);
  const completePayload = await completeResponse.json();
  assert.equal(completePayload.count, 1);
  assert.equal(completePayload.files[0].filename, filename);

  const savedContent = await fsp.readFile(path.join(tempRoot, filename), "utf8");
  assert.equal(savedContent, content);

  await assert.rejects(
    () => fsp.access(path.join(tempRoot, ".chunks", initPayload.uploadId)),
    /ENOENT/
  );
};

const testCancelRemovesStoredSession = async () => {
  const filename = "cancel-me.bin";
  const content = "abcdefghijk";
  const chunkSize = 4;
  const totalChunks = Math.ceil(content.length / chunkSize);

  const initResponse = await fetch(`${getBaseUrl()}/upload/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      size: content.length,
      chunkSize,
      totalChunks,
      lastModified: 456,
    }),
  });

  assert.equal(initResponse.status, 201);
  const initPayload = await initResponse.json();

  const chunkResponse = await uploadChunk({
    uploadId: initPayload.uploadId,
    chunkIndex: 0,
    chunkText: content.slice(0, chunkSize),
    filename,
  });
  assert.equal(chunkResponse.status, 200);

  const cancelResponse = await fetch(`${getBaseUrl()}/upload/${initPayload.uploadId}`, {
    method: "DELETE",
  });
  assert.equal(cancelResponse.status, 200);

  const statusResponse = await fetch(`${getBaseUrl()}/upload/status/${initPayload.uploadId}`);
  assert.equal(statusResponse.status, 404);
};

const run = async () => {
  try {
    await once(server, "listening");
    await testChunkedUploadResumeAndFinalize();
    await testCancelRemovesStoredSession();
    console.log("All upload integration tests passed.");
  } finally {
    await closeServer();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
