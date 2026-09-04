import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// .dev.vars.example is the only list of what this Worker needs configured.
// Nothing fails when a variable is missing from it: an unset var is just
// `undefined` at runtime, and each of these has a fallback that quietly means
// "less protection" — ALLOWED_IMAGE_HOSTS unset allows any host, APP_ORIGINS
// unset allows a wildcard CORS origin in development mode. An omission here
// is therefore invisible until someone goes looking for why a control is off.
const ROOT = path.join(__dirname, "..");
const EXAMPLE = fs.readFileSync(path.join(ROOT, ".dev.vars.example"), "utf-8");

const sources = fs
  .readdirSync(path.join(ROOT, "src"))
  .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map(f => fs.readFileSync(path.join(ROOT, "src", f), "utf-8"));

/**
 * Field names declared across every `interface Env` in src/.
 *
 * There are three, one per entry point, each declaring only what that file
 * uses — so the union is the real contract, and no single file can be read as
 * the source of truth.
 */
function envFields(): { name: string; type: string }[] {
  const fields: { name: string; type: string }[] = [];
  for (const source of sources) {
    for (const block of source.matchAll(/interface Env\s*\{([\s\S]*?)\n\}/g)) {
      for (const line of block[1].split("\n")) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*([^;]+);/);
        if (match) fields.push({ name: match[1], type: match[2].trim() });
      }
    }
  }
  return fields;
}

const declaredKeys = [...EXAMPLE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]);
const fields = envFields();
// Only string-typed members come from .dev.vars / `wrangler secret put`.
// DurableObjectNamespace members are wrangler.toml bindings.
const stringVars = [...new Set(fields.filter(f => f.type.includes("string")).map(f => f.name))].sort();
const bindings = [...new Set(fields.filter(f => !f.type.includes("string")).map(f => f.name))].sort();

describe(".dev.vars.example", () => {
  it("finds the Env declarations, so the checks below mean something", () => {
    // Without this, a regex that silently matched nothing would make every
    // other assertion here vacuously true.
    expect(stringVars).toContain("EDGE_CHAT_JWT_SECRET");
    expect(stringVars.length).toBeGreaterThanOrEqual(6);
    expect(bindings).toContain("CHAT_ROOM");
  });

  it("lists every environment variable the Worker reads", () => {
    const missing = stringVars.filter(name => !declaredKeys.includes(name));
    expect(missing).toEqual([]);
  });

  it("does not list wrangler.toml bindings as if they were variables", () => {
    // CHAT_ROOM and USER_HUB are Durable Object bindings. Putting them here
    // would send someone to `wrangler secret put` for something that cannot
    // be set that way.
    const wrong = bindings.filter(name => declaredKeys.includes(name));
    expect(wrong).toEqual([]);
  });

  it("lists key names without values, as its own header says", () => {
    const withValues = [...EXAMPLE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm)].map(m => m[1]);
    expect(withValues).toEqual([]);
  });

  it("declares each key once", () => {
    const duplicates = [...new Set(declaredKeys.filter(k => declaredKeys.filter(x => x === k).length > 1))];
    expect(duplicates.sort()).toEqual([]);
  });

  it("names the secret shared with Django on both sides of the pair", () => {
    // Django reads EDGE_CHAT_WEBHOOK_SECRET, this Worker reads
    // DJANGO_WEBHOOK_SECRET, and they must hold the same value — the two
    // names not matching is how they were once set to different values, which
    // made the offline-message webhook 403 silently.
    expect(declaredKeys).toContain("DJANGO_WEBHOOK_SECRET");
    expect(EXAMPLE).toMatch(/EDGE_CHAT_WEBHOOK_SECRET/);
  });
});
