# @dprint/clang-format

npm distribution of
[dprint-plugin-clang-format](https://github.com/dprint/dprint-plugin-clang-format)
which is an adapter plugin for
[clang-format](https://clang.llvm.org/docs/ClangFormat.html).

Use this with [@dprint/formatter](https://github.com/dprint/js-formatter) or
just use @dprint/formatter and download the
[dprint-plugin-clang-format Wasm file](https://github.com/dprint/dprint-plugin-clang-format/releases).

## Example

```ts
import { getBuffer } from "@dprint/clang-format";
import { createFromBuffer } from "@dprint/formatter";

const formatter = createFromBuffer(getBuffer());

console.log(
  formatter.formatText({
    filePath: "test.cpp",
    fileText: "int main(){return 0;}",
  }),
);
```
