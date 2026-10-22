import { createHash } from "node:crypto";
import { defaultSystemPrompt } from "../config.js";

// Exact shipped defaults from config.ts history, not substring/pattern matches.
// A user's edits (including appended instructions) must never be discarded.
const historicalDefaults = new Set([
  "86d881a28c00daf2700986a7715537237108e17d7eabc1327a10e9179ccb436c", // step-6 default
  "2facfc5d3de726225dd97c23891168bcc5b12cbcd98a15d9207c481d6285773b", // b8a467e
  "4b45e6be4efeb131fa1f8e2986717faddbed9c3b78e6a6d2efd2d71470b926ad", // d14633c
  "87cb7a711598df1793a0f5b216fc3640df3a5785fa94f77cc213f4ffdf662d3f", // 4429a08
  "c8d308bc1a37c371cbb0a28cf4ec0eaecc886bf06c1a0c4f1e5046ceb5f245b3", // 11c92ef (benchmark baseline)
  "3b0ec5e9e0faeb0f6e3a634b3dcfc73c82bb1b996f301fafb3f6a420d2a2e395" // 8704502
]);

/** Read-time normalization only; never rewrite saved settings or checkpoints. */
export function migrateBuiltInSystemPrompt(value: string) {
  return historicalDefaults.has(createHash("sha256").update(value).digest("hex")) ? defaultSystemPrompt : value;
}
