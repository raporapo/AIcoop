/**
 * 準備の画面（5.14 の3）が作る設定の変更：yaml の決まった値だけを書き換える。
 *
 * `yaml` の Document で読み、書き換える値の、もとの文字の範囲（`range`）だけを置き換える。ほかの行
 * （コメント・空行・並び・引用符の付け方）は1文字も変えない。置き換えた値は JSON の文字列の形
 * （YAML の二重引用符の文字列としても正しい）で書き、書いたあとで読み直して、意図した値になったかを確かめる。
 */
import { PLACEHOLDER_GITHUB_OWNER } from "@aicoop/shared/api";
import { isMap, isNode, isScalar, isSeq, type Node, parseDocument, type YAMLSeq } from "yaml";

/** 書き換えられない（yaml が読めない・書き換える場所がない）。message は利用者に見せる日本語 */
export class YamlEditError extends Error {
  override name = "YamlEditError";
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function parse(text: string, file: string) {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new YamlEditError(`${file} を yaml として読めないので、書き換えられません`);
  }
  return doc;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function rangeOf(node: Node): { start: number; end: number } {
  const range = node.range;
  if (!range) throw new YamlEditError("書き換える場所が分かりません");
  return { start: range[0], end: range[1] };
}

/** aicoop.yaml の `company.name` を書き換える（5.14 の3の1） */
export function setCompanyName(text: string, name: string): string {
  const doc = parse(text, "aicoop.yaml");
  const node = doc.getIn(["company", "name"], true);
  if (!isScalar(node)) {
    throw new YamlEditError("aicoop.yaml に company.name がないので、書き換えられません");
  }
  const out = applyEdits(text, [{ ...rangeOf(node), text: JSON.stringify(name) }]);
  const check = parseDocument(out);
  if (check.errors.length > 0 || check.getIn(["company", "name"]) !== name) {
    throw new YamlEditError("aicoop.yaml の company.name を書き換えられませんでした");
  }
  return out;
}

/**
 * 文字列の並びを置き換える。flow（`[a, b]`）はそのまま flow で、block（`- a` の行）は同じ字下げの block で書く。
 * block の範囲は、最初の `-` から最後の値の終わりまで（そのあとの改行・コメントは残す）
 */
function seqEdit(text: string, seq: YAMLSeq, values: readonly string[]): Edit {
  const quoted = values.map((v) => JSON.stringify(v));
  if (seq.flow) return { ...rangeOf(seq), text: `[${quoted.join(", ")}]` };
  const start = rangeOf(seq).start;
  const last = seq.items.at(-1);
  if (last === undefined || !isNode(last)) throw new YamlEditError("書き換える場所が分かりません");
  const end = rangeOf(last).end;
  const indent = start - (text.lastIndexOf("\n", start - 1) + 1);
  return { start, end, text: quoted.map((q) => `- ${q}`).join(`\n${" ".repeat(indent)}`) };
}

const isPlaceholder = (value: unknown) =>
  typeof value === "string" && value.includes(PLACEHOLDER_GITHUB_OWNER);

/**
 * groups.yaml の部署の上限（`groups.<id>.ceiling[].params.repo`）にある、雛形の `your-org` を含む値を、
 * `repositories` に置き換える（5.14 の3の3）。同じ並びの your-org でない値は残し、重ねて書かない。
 * your-org がどこにもなければ失敗（何も書き換えない）
 */
export function replacePlaceholderRepositories(
  text: string,
  repositories: readonly string[],
): { readonly content: string; readonly replaced: number } {
  const doc = parse(text, "groups.yaml");
  const groups = doc.get("groups", true);
  const edits: Edit[] = [];
  const expected: string[][] = [];
  if (isMap(groups)) {
    for (const pair of groups.items) {
      const group = pair.value;
      if (!isMap(group)) continue;
      const ceiling = group.get("ceiling", true);
      if (!isSeq(ceiling)) continue;
      for (const item of ceiling.items) {
        if (!isMap(item)) continue;
        const params = item.get("params", true);
        if (!isMap(params)) continue;
        const repo = params.get("repo", true);
        if (!isSeq(repo)) continue;
        const values = repo.items.map((v) => (isScalar(v) ? v.value : undefined));
        if (!values.some(isPlaceholder)) continue;
        const kept = values.filter((v): v is string => typeof v === "string" && !isPlaceholder(v));
        const next = [...new Set([...kept, ...repositories])];
        edits.push(seqEdit(text, repo, next));
        expected.push(next);
      }
    }
  }
  if (edits.length === 0) {
    throw new YamlEditError(
      `groups.yaml の部署の上限に、雛形の「${PLACEHOLDER_GITHUB_OWNER}」がもうありません。リポジトリを変えるときは、設定の画面で groups.yaml を書き換えてください`,
    );
  }
  const content = applyEdits(text, edits);
  // 読み直して、置き換えた値になったかを確かめる（ほかの値は、範囲の外なので変わっていない）
  const check = parseDocument(content);
  if (check.errors.length > 0) {
    throw new YamlEditError("groups.yaml を書き換えられませんでした");
  }
  return { content, replaced: expected.length };
}
