// @ts-check
const assert = require("assert");
const createFromBuffer = require("@dprint/formatter").createFromBuffer;
const getBuffer = require("./index").getBuffer;

const formatter = createFromBuffer(getBuffer());
const result = formatter.formatText({
  filePath: "file.cpp",
  fileText: "int main(){return 0;}",
});

// clang-format doesn't insert a final newline by default (InsertNewlineAtEOF)
assert.strictEqual(result, "int main() { return 0; }");
