/**
 * 5.8 の4 (7) ホストの道具・(8) CEO に頼む：P4 で使えるようになる、と分かる画面だけ。
 */
export function LaterScreen({ kind }: { readonly kind: "host-tools" | "ceo" }) {
  if (kind === "host-tools") {
    return (
      <>
        <h1>ホストの道具</h1>
        <p className="notice notice-info">
          <span aria-hidden="true">ⓘ </span>
          ホストの道具（ComfyUI など）の状態の確認と、起動・停止は、P4 で使えるようになります。
        </p>
      </>
    );
  }
  return (
    <>
      <h1>CEO に頼む</h1>
      <p className="notice notice-info">
        <span aria-hidden="true">ⓘ </span>
        CEO（AI）に仕事を頼む画面は、P4 で使えるようになります。それまでは{" "}
        <a href="#/tasks/new">手動のタスク</a>で、社員に直接頼めます。
      </p>
    </>
  );
}
