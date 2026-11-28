/**
 * 承認の対象の要約（保留は 5.7.1 の2、一時権限は 5.7.3 の2）を、項目ごとに見せる。
 * 承認の署名の summary_sha256 はこの要約から作るので、知らない項目も含めて全部を出す。
 */
import type { DescribedSummary, SummaryField } from "../lib/summary.ts";
import { SafeText, Untrusted } from "./text.tsx";

function FieldValue({ field }: { readonly field: SummaryField }) {
  const { value } = field;
  if (field.warning === true) {
    if (value.type === "list" && value.items.length === 0)
      return <span className="muted">（なし）</span>;
    const items = value.type === "list" ? value.items : value.type === "text" ? [value.text] : [];
    return (
      <div className="notice notice-warn" role="note">
        <ul className="plain-list">
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            <li key={i}>
              <span aria-hidden="true">⚠ </span>
              <SafeText text={item} />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (field.prose && value.type === "text") {
    return <Untrusted label={field.label} text={value.text} source="AI 社員・外の人" />;
  }
  if (field.prose && value.type === "list") {
    return value.items.length === 0 ? (
      <span className="muted">（なし）</span>
    ) : (
      <Untrusted label={field.label} text={value.items.join("\n")} source="AI 社員・外の人" />
    );
  }
  switch (value.type) {
    case "empty":
      return <span className="muted">（なし）</span>;
    case "text":
      return <SafeText text={value.text} />;
    case "list":
      return value.items.length === 0 ? (
        <span className="muted">（なし）</span>
      ) : (
        <ul className="plain-list">
          {value.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            <li key={i}>
              <SafeText text={item} />
            </li>
          ))}
        </ul>
      );
    case "json":
      return <Untrusted label={field.label} text={value.text} mono />;
  }
}

export function SummarySection({ summary }: { readonly summary: DescribedSummary }) {
  return (
    <section aria-labelledby="summary-heading" className="section">
      <h2 id="summary-heading">要約：{summary.kindLabel}</h2>
      <p className="muted small">
        制御サーバーが作った要約です。承認・却下の署名には、この要約（すべての項目）の SHA-256
        が入ります。
      </p>
      <dl className="summary">
        {summary.fields.map((f) => (
          <div key={f.key} className="summary-row">
            <dt>{f.label}</dt>
            <dd>
              <FieldValue field={f} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
