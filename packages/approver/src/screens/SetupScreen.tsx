/**
 * 準備の画面（5.14 の3）：会社の名前 → Claude へのログイン → GitHub → 箱のイメージ の順に並べ、
 * 済んだ項目に印を付ける。何度でも開き直せる（`#/setup`）。項目は `aicoop check` の「準備の確認」と同じ。
 *
 * - 設定・資格を変えるものは、どれも変更を作ってからパスキーで署名して保存する（ConfigChangeReview・
 *   SecretChangeReview。5.14 の4の3・5）
 * - Claude へのログイン：daemon がホストで `claude setup-token` を動かし、出たログイン用の URL を開くボタンを出す。
 *   ブラウザに出たコードを貼ると、daemon が setup-token に渡し、トークンから資格の変更を作る。トークンはこの画面に来ない
 * - GitHub の資格の欄は type=password で、React の状態に入れず、送る前に空にする（資格の画面と同じ。ST-25）
 * - PC のブラウザだけ（5.14 の6）
 */
import {
  type ApprovalAssertResponse,
  type ClaudeLoginView,
  type CreateConfigChangeResponse,
  type CreateSecretChangeResponse,
  type ImageBuildView,
  isClaudeLoginUrl,
  isRepositoryPattern,
  MAX_COMPANY_NAME_CHARS,
  MAX_LOGIN_CODE_CHARS,
  MAX_SETUP_REPOSITORIES,
  type SecretKindName,
  type SetupItem,
  type SetupResponse,
  type SetupStepId,
} from "@aicoop/shared/api";
import { type ReactNode, useId, useRef, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ConfigChangeReview, SecretChangeReview } from "../components/ChangeReview.tsx";
import { SafeText } from "../components/text.tsx";
import { ErrorBox, LoadFailed, Loading } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { toFailure, useResource } from "../lib/resource.ts";
import { kindLabel, SECRET_FIELDS, secretValue } from "../lib/secret-form.ts";

const STEP_TITLE: Readonly<Record<SetupStepId, string>> = {
  company: "会社の名前",
  claude: "Claude へのログイン",
  github: "GitHub",
  image: "箱のイメージ",
};

/** 雛形の会社の名前（D-30。daemon の DEFAULT_COMPANY_NAME と同じ） */
const PLACEHOLDER_COMPANY_NAME = "わたしの会社";

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function StepMark({ ok }: { readonly ok: boolean }) {
  return ok ? (
    <span className="badge tone-ok">
      <span aria-hidden="true">✓</span> 済み
    </span>
  ) : (
    <span className="badge tone-wait">
      <span aria-hidden="true">○</span> まだ
    </span>
  );
}

function Items({ items }: { readonly items: readonly SetupItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="setup-items">
      {items.map((item) => (
        <li key={item.id}>
          <span aria-hidden="true">{item.ok ? "✓ " : "→ "}</span>
          <span className="sr-only">{item.ok ? "済み：" : "まだ："}</span>
          <SafeText text={item.message} />
          {!item.ok && item.hint !== undefined && (
            <span className="muted small">
              {" "}
              （<SafeText text={item.hint} />）
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Step({
  n,
  id,
  data,
  children,
}: {
  readonly n: number;
  readonly id: SetupStepId;
  readonly data: SetupResponse;
  readonly children: ReactNode;
}) {
  const step = data.steps.find((s) => s.id === id);
  const headingId = `setup-${id}-heading`;
  return (
    <section className="setup-step" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {n}. {STEP_TITLE[id]} <StepMark ok={step?.ok ?? false} />
      </h2>
      <Items items={step?.items ?? []} />
      {children}
    </section>
  );
}

export function SetupScreen() {
  const app = useApp();
  const setup = useResource(() => app.api.setup(), { key: "setup", poll: false });
  const data = setup.data;
  const reload = () => void setup.reload();

  return (
    <>
      <h1>準備</h1>
      <p>
        AI 社員が動けるように、上から順に用意します。済んだものには「✓
        済み」が付きます。あとから何度でも、この画面を開き直せます。
      </p>
      {data === undefined ? (
        setup.error !== undefined ? (
          <LoadFailed error={setup.error} what="準備の確認" />
        ) : (
          <Loading what="準備の確認" />
        )
      ) : (
        <>
          {data.ready ? (
            <p className="notice notice-ok" role="status">
              <span aria-hidden="true">✓ </span>
              準備ができています。<a href="#/status">稼働状況</a>
              で、AI 社員の仕事を見られます。
            </p>
          ) : (
            <ol className="setup-overview" aria-label="準備の進み具合">
              {data.steps.map((s) => (
                <li key={s.id}>
                  {STEP_TITLE[s.id]}：<StepMark ok={s.ok} />
                </li>
              ))}
            </ol>
          )}
          <Step n={1} id="company" data={data}>
            <CompanyForm current={data.company.name} onSaved={reload} />
          </Step>
          <Step n={2} id="claude" data={data}>
            <ClaudeLogin
              initial={data.claude_login}
              registered={data.steps.find((s) => s.id === "claude")?.ok ?? false}
              onChanged={reload}
            />
          </Step>
          <Step n={3} id="github" data={data}>
            <GitHubForms data={data} onSaved={reload} />
          </Step>
          <Step n={4} id="image" data={data}>
            <ImageBuild initial={data.image_build} onFinished={reload} />
          </Step>
          {data.others.length > 0 && (
            <section aria-labelledby="setup-others-heading">
              <h2 id="setup-others-heading">ほかの準備</h2>
              <Items items={data.others} />
              <p className="muted small">
                ほかのサービスの資格は、<a href="#/secrets">資格</a>の画面で登録します。
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}

// ---- 1. 会社の名前 ----

function CompanyForm({
  current,
  onSaved,
}: {
  readonly current: string;
  readonly onSaved: () => void;
}) {
  const app = useApp();
  const field = useId();
  const [name, setName] = useState(current === PLACEHOLDER_COMPANY_NAME ? "" : current);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<CreateConfigChangeResponse | null>(null);

  const submit = async () => {
    const value = name.trim();
    setProblem(null);
    setFailure(null);
    if (value === "") return setProblem("会社の名前を入れてください");
    if (CONTROL.test(value)) return setProblem("会社の名前に、改行や制御文字は使えません");
    if ([...value].length > MAX_COMPANY_NAME_CHARS) {
      return setProblem(`会社の名前は${MAX_COMPANY_NAME_CHARS}文字までにしてください`);
    }
    if (value === current) return setProblem("いまの名前と同じです");
    setBusy(true);
    try {
      setChange(await app.api.setupCompany({ name: value }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        承認アプリに出す会社の名前です（<code>aicoop.yaml</code> の <code>company.name</code>
        ）。いまは「
        <SafeText text={current} />
        」です。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={field}>会社の名前</label>
          <input
            id={field}
            type="text"
            value={name}
            maxLength={MAX_COMPANY_NAME_CHARS * 2}
            autoComplete="organization"
            onChange={(e) => {
              setName(e.target.value);
              setChange(null);
            }}
          />
        </div>
        <button type="submit" disabled={busy}>
          名前を変える変更を作る
        </button>
      </form>
      {problem !== null && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}
      {failure !== null && <ErrorBox error={failure} title="変更を作れませんでした" />}
      {change !== null && (
        <ConfigChangeReview
          key={change.id}
          id={change.id}
          summary={change.summary}
          warnings={change.warnings}
          expiresAt={change.expires_at}
          onSettled={(r: ApprovalAssertResponse | null) => {
            if (r !== null) onSaved();
          }}
        />
      )}
    </>
  );
}

// ---- 2. Claude へのログイン ----

const LOGIN_DONE_STATES: ReadonlySet<ClaudeLoginView["state"]> = new Set([
  "failed",
  "cancelled",
  "expired",
]);

function ClaudeLogin({
  initial,
  registered,
  onChanged,
}: {
  readonly initial: ClaudeLoginView | null;
  /** 資格 anthropic がもう登録されている（済んだログインの変更を、もう一度は出さない） */
  readonly registered: boolean;
  readonly onChanged: () => void;
}) {
  const app = useApp();
  const codeField = useId();
  const codeInput = useRef<HTMLInputElement | null>(null);
  const [login, setLogin] = useState<ClaudeLoginView | null>(initial);
  // 開いたときに、済んだログインの資格がもう登録されていれば、その変更は署名し終えている
  const [settled, setSettled] = useState(initial?.state === "done" && registered);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState<null | "start" | "code" | "cancel">(null);

  const run = async (kind: "start" | "code" | "cancel", call: () => Promise<ClaudeLoginView>) => {
    setBusy(kind);
    setFailure(null);
    try {
      setLogin(await call());
      setSettled(false);
    } catch (e) {
      setFailure(toFailure(e));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const start = () => {
    setProblem(null);
    void run("start", () => app.api.startClaudeLogin());
  };

  const submitCode = () => {
    const el = codeInput.current;
    const code = (el?.value ?? "").trim();
    if (el) el.value = "";
    setProblem(null);
    if (login === null) return;
    if (code === "") return setProblem("ブラウザに出たコードを貼り付けてください");
    if (code.length > MAX_LOGIN_CODE_CHARS || CONTROL.test(code)) {
      return setProblem(
        "コードの形が違います（改行・制御文字を含むか、長すぎます）。ブラウザに出たコードだけを貼り付けてください",
      );
    }
    void run("code", () => app.api.submitClaudeLoginCode(login.id, code));
  };

  const url = login?.state === "waiting_code" ? login.url : null;
  const urlOk = url !== null && isClaudeLoginUrl(url);

  return (
    <>
      <p>
        AI 社員は、オーナーの Claude
        のサブスクの枠で動きます（5.4.1）。ここからログインすると、制御サーバーが
        <code>claude setup-token</code> で1年有効のトークンを作り、資格 <code>anthropic</code>{" "}
        として登録します（パスキーで署名してから）。トークンはこの画面には出ません。
      </p>

      {login?.state === "waiting_code" ? (
        <div className="setup-login">
          {urlOk ? (
            <p>
              <a
                className="button-link-primary"
                href={url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                ブラウザで Claude にログインする
              </a>
            </p>
          ) : (
            <p className="notice notice-error" role="alert">
              ログイン用の URL の形が違うので、開きません。取り消して、もう一度始めてください。
            </p>
          )}
          <p className="muted small">
            ログインのあと、ブラウザに出たコードをコピーして、下に貼り付けてください。始めてから10分で取り消します。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCode();
            }}
            autoComplete="off"
          >
            <div className="field">
              <label htmlFor={codeField}>ブラウザに出たコード</label>
              <input
                id={codeField}
                ref={codeInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-1p-ignore=""
                data-lpignore="true"
              />
            </div>
            <button type="submit" className="button-primary" disabled={busy !== null}>
              {busy === "code" ? "トークンを受け取っています…" : "コードを渡す"}
            </button>{" "}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("cancel", () => app.api.cancelClaudeLogin(login.id))}
            >
              取り消す
            </button>
          </form>
        </div>
      ) : login?.state === "done" && login.change !== null && !settled ? (
        <SecretChangeReview
          key={login.change.id}
          id={login.change.id}
          summary={login.change.summary}
          expiresAt={login.change.expires_at}
          onSettled={(r) => {
            if (r !== null) {
              setSettled(true);
              setSaved(r.subject_status === "applied");
              onChanged();
            }
          }}
        />
      ) : (
        <>
          {saved && (
            <p className="notice notice-ok" role="status">
              <span aria-hidden="true">✓ </span>
              Claude のトークンを登録しました（資格 <code>anthropic</code>）。
            </p>
          )}
          {login !== null && LOGIN_DONE_STATES.has(login.state) && login.message !== null && (
            <p className="notice notice-warn" role="status">
              <span aria-hidden="true">⚠ </span>
              <SafeText text={login.message} />
            </p>
          )}
          <button type="button" className="button-primary" disabled={busy !== null} onClick={start}>
            {busy === "start" ? "ログインの準備をしています…" : "Claude にログインする"}
          </button>
        </>
      )}
      {problem !== null && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}
      {failure !== null && <ErrorBox error={failure} title="ログインできませんでした" />}
    </>
  );
}

// ---- 3. GitHub ----

const GITHUB_KINDS: ReadonlyArray<SecretKindName> = ["static_token", "github_app"];

function GitHubForms({
  data,
  onSaved,
}: {
  readonly data: SetupResponse;
  readonly onSaved: () => void;
}) {
  return (
    <>
      <GitHubSecretForm
        secretId={data.github.secret_id}
        current={data.github.secret_kind}
        onSaved={onSaved}
      />
      <RepositoriesForm
        placeholder={data.github.placeholder}
        current={data.github.repositories}
        onSaved={onSaved}
      />
    </>
  );
}

function GitHubSecretForm({
  secretId,
  current,
  onSaved,
}: {
  readonly secretId: string;
  readonly current: SecretKindName | null;
  readonly onSaved: () => void;
}) {
  const app = useApp();
  const kindField = useId();
  const fieldId = useId();
  const [kind, setKind] = useState<SecretKindName>(
    current === "github_app" ? "github_app" : "static_token",
  );
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<CreateSecretChangeResponse | null>(null);

  const submit = async () => {
    const values: Record<string, string> = {};
    for (const f of SECRET_FIELDS[kind]) {
      const el = inputs.current[f.key];
      values[f.key] = el?.value ?? "";
      if (el) el.value = "";
    }
    setProblem(null);
    setFailure(null);
    setChange(null);
    const empty = SECRET_FIELDS[kind].filter((f) => (values[f.key] ?? "").trim() === "");
    if (empty.length > 0) {
      return setProblem(
        `${empty.map((f) => f.label).join("・")}が空です。入力した中身は消しました`,
      );
    }
    setBusy(true);
    try {
      setChange(
        await app.api.createSecretChange({
          id: secretId,
          kind,
          value: secretValue(kind, values),
        }),
      );
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-sub">
      <h3>資格</h3>
      <p>
        {current === null ? (
          "GitHub の資格は、まだ登録されていません。"
        ) : (
          <>いまは {kindLabel(current)} が登録されています。置き換えるなら、下に貼り付けます。</>
        )}{" "}
        fine-grained の個人用トークン（static_token）か、GitHub App（github_app）を使います。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        autoComplete="off"
      >
        <div className="field">
          <label htmlFor={kindField}>資格の種類</label>
          <select
            id={kindField}
            value={kind}
            onChange={(e) => setKind(e.target.value as SecretKindName)}
          >
            {GITHUB_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        {SECRET_FIELDS[kind].map((f) => (
          <div className="field" key={`${kind}-${f.key}`}>
            <label htmlFor={`${fieldId}-${f.key}`}>{f.label}</label>
            <input
              id={`${fieldId}-${f.key}`}
              ref={(el) => {
                inputs.current[f.key] = el;
              }}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-1p-ignore=""
              data-lpignore="true"
            />
            {f.hint !== undefined && <p className="muted small">{f.hint}</p>}
          </div>
        ))}
        <button type="submit" disabled={busy}>
          GitHub の資格の変更を作る
        </button>
        <p className="muted small">
          押すと、入力した中身はすぐにこの画面から消します。パスキーで署名するまで資格は変わりません。
        </p>
      </form>
      {problem !== null && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}
      {failure !== null && <ErrorBox error={failure} title="変更を作れませんでした" />}
      {change !== null && (
        <SecretChangeReview
          key={change.id}
          id={change.id}
          summary={change.summary}
          expiresAt={change.expires_at}
          onSettled={(r) => {
            if (r !== null) onSaved();
          }}
        />
      )}
    </div>
  );
}

function RepositoriesForm({
  placeholder,
  current,
  onSaved,
}: {
  readonly placeholder: boolean;
  readonly current: readonly string[];
  readonly onSaved: () => void;
}) {
  const app = useApp();
  const field = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<CreateConfigChangeResponse | null>(null);

  const submit = async () => {
    const list = text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    setProblem(null);
    setFailure(null);
    if (list.length === 0) return setProblem("リポジトリを1つ以上入れてください");
    if (list.length > MAX_SETUP_REPOSITORIES) {
      return setProblem(`リポジトリは ${MAX_SETUP_REPOSITORIES} 個までです`);
    }
    const bad = list.filter((r) => !isRepositoryPattern(r));
    if (bad.length > 0) {
      return setProblem(
        `形が違います：${bad.slice(0, 3).join("、")}。owner/repo か owner/*（owner は GitHub のユーザー名か組織名）で書いてください。*/*・../・空白・your-org は使えません`,
      );
    }
    setBusy(true);
    try {
      setChange(await app.api.setupRepositories({ repositories: [...new Set(list)] }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-sub">
      <h3>AI が触ってよいリポジトリ</h3>
      {current.length > 0 && (
        <p>
          いまの部署の上限：
          {current.map((r, i) => (
            <span key={r}>
              {i > 0 && "、"}
              <code>
                <SafeText text={r} />
              </code>
            </span>
          ))}
        </p>
      )}
      {placeholder ? (
        <>
          <p>
            <code>groups.yaml</code> の雛形の <code>your-org/*</code>{" "}
            を、ここに入れたリポジトリに書き換えます。1行に1つ、<code>owner/repo</code>
            （1つのリポジトリ）か <code>owner/*</code>（そのユーザー・組織のすべて）で書きます。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor={field}>リポジトリ（1行に1つ）</label>
              <textarea
                id={field}
                rows={3}
                value={text}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="例：my-name/my-app"
                onChange={(e) => {
                  setText(e.target.value);
                  setChange(null);
                }}
              />
            </div>
            <button type="submit" disabled={busy}>
              リポジトリを書き換える変更を作る
            </button>
          </form>
        </>
      ) : (
        <p className="muted small">
          雛形の <code>your-org</code> は、もう書き換えてあります。変えるときは、
          <a href="#/settings">設定</a>の画面で <code>groups.yaml</code> を書き換えてください。
        </p>
      )}
      {problem !== null && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}
      {failure !== null && <ErrorBox error={failure} title="変更を作れませんでした" />}
      {change !== null && (
        <ConfigChangeReview
          key={change.id}
          id={change.id}
          summary={change.summary}
          warnings={change.warnings}
          expiresAt={change.expires_at}
          onSettled={(r) => {
            if (r !== null) {
              setText("");
              onSaved();
            }
          }}
        />
      )}
    </div>
  );
}

// ---- 4. 箱のイメージ ----

/** 画面に出すログの行の数 */
const SHOWN_LINES = 30;

function ImageBuild({
  initial,
  onFinished,
}: {
  readonly initial: ImageBuildView | null;
  readonly onFinished: () => void;
}) {
  const app = useApp();
  const [started, setStarted] = useState<ImageBuildView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const running = (started ?? initial)?.state === "running";
  const lastState = useRef<ImageBuildView["state"] | null>(null);
  const progress = useResource(
    async () => {
      const { build } = await app.api.imageBuild();
      if (lastState.current === "running" && build !== null && build.state !== "running") {
        onFinished();
      }
      lastState.current = build?.state ?? null;
      return build;
    },
    { key: `image-build-${started?.id ?? "none"}`, poll: running },
  );
  const build = progress.data ?? started ?? initial;

  const start = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const view = await app.api.startImageBuild();
      lastState.current = view.state;
      setStarted(view);
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        AI 社員が仕事をする箱（vm）の中身を作ります（<code>aicoop image build</code>{" "}
        と同じこと。数分かかります）。部署の packages を変えたときも、作り直します。
      </p>
      <button
        type="button"
        className="button-primary"
        disabled={busy || build?.state === "running"}
        onClick={() => void start()}
      >
        {build?.state === "running" ? "イメージを作っています…" : "イメージを作る"}
      </button>
      {failure !== null && <ErrorBox error={failure} title="イメージを作り始められませんでした" />}
      {build !== null && build !== undefined && (
        <div className="setup-build" aria-live="polite">
          {build.state === "running" ? (
            <p role="status">
              {build.stage !== null ? (
                <>
                  段階 {build.stage.index}/{build.stage.total}：
                  <SafeText text={build.stage.label} />
                </>
              ) : (
                "作り始めました…"
              )}{" "}
              <button type="button" className="button-small" onClick={() => void progress.reload()}>
                進み具合を読み直す
              </button>
            </p>
          ) : (
            <p
              className={`notice ${build.state === "succeeded" ? "notice-ok" : "notice-error"}`}
              role="status"
            >
              <span aria-hidden="true">{build.state === "succeeded" ? "✓ " : "✕ "}</span>
              <SafeText text={build.message ?? ""} />
            </p>
          )}
          {build.lines.length > 0 && (
            <details open={build.state !== "succeeded"}>
              <summary>ログ（最後の {Math.min(build.lines.length, SHOWN_LINES)} 行）</summary>
              <pre className="data">
                {build.lines.slice(-SHOWN_LINES).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                  <span key={i}>
                    <SafeText text={line} />
                    {"\n"}
                  </span>
                ))}
              </pre>
            </details>
          )}
        </div>
      )}
    </>
  );
}
