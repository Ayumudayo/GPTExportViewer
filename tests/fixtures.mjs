import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

export async function makeFixtureExportRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt-export-viewer-"));
  const cacheDir = path.join(root, ".cache");
  const good = path.join(root, "chatgpt-export-good");
  const partial = path.join(root, "chatgpt-export-partial");
  await mkdir(good, { recursive: true });
  await mkdir(partial, { recursive: true });

  await writeJson(path.join(good, "conversations.json"), [
    {
      id: "conv-1",
      conversation_id: "thread-1",
      title: "Alpha image work",
      create_time: 1710000000,
      update_time: 1710000600,
      current_node: "msg2",
      default_model_slug: "gpt-4o",
      is_archived: false,
      is_starred: true,
      mapping: {
        root: { id: "root", parent: null, children: ["msg1"] },
        msg1: {
          id: "msg1",
          parent: "root",
          children: ["msg2"],
          message: {
            id: "m1",
            author: { role: "user" },
            create_time: 1710000001,
            content: { content_type: "text", parts: ["Please make an image"] },
            metadata: {
              attachments: [{ file_id: "file-input", name: "input.png", mime_type: "image/png" }]
            }
          }
        },
        msg2: {
          id: "msg2",
          parent: "msg1",
          children: [],
          message: {
            id: "m2",
            author: { role: "assistant" },
            create_time: 1710000002,
            content: {
              content_type: "multimodal_text",
              parts: [{ content_type: "text", text: "Here is image" }, "Done"]
            },
            metadata: {
              attachments: [{ file_id: "file-img-1", name: "library.png", mime_type: "image/png" }]
            }
          }
        }
      }
    },
    {
      id: "conv-2",
      title: "Über 한글 메모",
      create_time: 1710000900,
      update_time: 1710001000,
      is_archived: true,
      mapping: {
        node1: {
          id: "node1",
          parent: null,
          children: [],
          message: {
            id: "m3",
            author: { role: "user" },
            create_time: 1710000901,
            content: { text: "Loose text shape" }
          }
        }
      }
    },
    {
      id: "conv-parent-only",
      title: "Parent only chain",
      create_time: 1710001100,
      update_time: 1710001300,
      mapping: {
        parentRoot: {
          id: "parentRoot",
          parent: null,
          message: {
            id: "pm1",
            author: { role: "user" },
            create_time: 1710001101,
            content: { content_type: "text", parts: ["Root message"] }
          }
        },
        parentChild: {
          id: "parentChild",
          parent: "parentRoot",
          message: {
            id: "pm2",
            author: { role: "assistant" },
            create_time: 1710001102,
            content: { content_type: "text", parts: ["Child message"] }
          }
        },
        parentGrandchild: {
          id: "parentGrandchild",
          parent: "parentChild",
          message: {
            id: "pm3",
            author: { role: "user" },
            create_time: 1710001103,
            content: { content_type: "text", parts: ["Grandchild message"] }
          }
        }
      }
    }
  ]);

  await writeJson(path.join(good, "library_files.json"), [
    {
      file_id: "file-img-1",
      file_name: "library generated.png",
      mime_type: "image/png",
      file_size_bytes: tinyPng.length,
      created_at: "2024-03-09T16:00:02Z",
      state: "ready",
      library_file_category: "image",
      origination_thread_id: "conv-1",
      origination_message_id: "m2"
    },
    {
      file_id: "file-doc-1",
      file_name: "notes.txt",
      mime_type: "text/plain",
      file_size_bytes: 4,
      created_at: "2024-03-09T16:00:04Z",
      state: "ready",
      library_file_category: "file"
    },
    {
      file_id: "file-img-missing",
      file_name: "Über 누락.png",
      mime_type: "image/png",
      file_size_bytes: 99,
      created_at: "2024-03-09T16:00:05Z",
      state: "ready",
      library_file_category: "image"
    }
  ]);
  await writeJson(path.join(good, "conversation_asset_file_names.json"), {
    "file-img-1.dat": "한글 이미지.png"
  });
  await writeFile(path.join(good, "file-img-1.dat"), tinyPng);

  await writeJson(path.join(partial, "conversations.json"), []);

  return { root, cacheDir, good, partial };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
