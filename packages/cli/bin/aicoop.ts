#!/usr/bin/env node
// aicoop コマンド（設計書 9.1）。Node.js 24 は .ts を型を除いてそのまま動かす。
import { runCli } from "../src/main.ts";

const code = await runCli();
process.exitCode = code;
// 終わったのに、読み込んだ部品のタイマーなどで残り続けないようにする（出力は先に書き終える）
setTimeout(() => process.exit(code), 2000).unref();
