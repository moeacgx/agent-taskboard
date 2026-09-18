// dashi-taskboard's own server code ships as plain .mjs with no declaration
// files. This test imports it directly to run the real HTTP API in-process;
// this ambient declaration just tells TypeScript that's expected, instead of
// flagging every such import as an implicit `any`. The actual shape used is
// cast explicitly at the one import site in dashi-api.test.ts.
declare module "*.mjs";
