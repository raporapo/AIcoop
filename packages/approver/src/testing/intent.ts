/**
 * テスト用：`POST /approvals/intent`・`/approvals/assert` の偽物（daemon と同じ形の payload を作る）。
 */
import type {
  ApprovalAssertResponse,
  ApprovalPayload,
  ApprovalSubjectType,
} from "@aicoop/shared/api";
import { canonicalJson, sha256Base64Url, sha256Hex } from "../lib/canonical.ts";
import { type FakeApi, ok } from "./fake-api.ts";
import { COMPANY_ID, iso, MIN, NOW } from "./fixtures.ts";

export interface IntentOptions {
  /** 対象の ID から、daemon が覚えている要約（summary_sha256 のもと） */
  readonly summaryOf: (id: string) => unknown;
  /** summary_sha256 をこの値にする（拒否側のテスト） */
  readonly summarySha?: string;
}

export function fakeIntent(api: FakeApi, options: IntentOptions): void {
  api.on("POST /approvals/intent", async (req) => {
    const body = req.body as {
      type: ApprovalSubjectType;
      id: string;
      decision: "approve" | "reject";
    };
    const payload: ApprovalPayload = {
      ...body,
      company_id: COMPANY_ID,
      summary_sha256:
        options.summarySha ?? (await sha256Hex(canonicalJson(options.summaryOf(body.id)))),
      issued_at: iso(NOW),
      expires_at: iso(NOW + 2 * MIN),
      nonce: "bm9uY2U",
    };
    return ok({
      payload,
      options: {
        challenge: await sha256Base64Url(canonicalJson(payload)),
        allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
        userVerification: "required",
      },
    });
  });
}

export function assertOk(
  type: ApprovalSubjectType,
  id: string,
  decision: "approve" | "reject",
  status: string,
) {
  const body: ApprovalAssertResponse = {
    approval: {
      id: "a_01JQ0000000000000000000002",
      subject_type: type,
      subject_id: id,
      decision,
      device_id: "d_01JQ0000000000000000000001",
      verified_at: iso(NOW),
    },
    subject_status: status,
  };
  return ok(body);
}
