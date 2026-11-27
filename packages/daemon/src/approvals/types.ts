/**
 * 承認の署名（5.8 の3）と、承認される対象（保留・一時権限など）の境界。
 *
 * 署名を確かめる側（`approvals/`）は、対象の中身を知らない。対象ごとに `ApprovalTarget` を登録し、
 * 署名が通ったら `apply` で状態を変えてもらう。保留の再送（5.2.6 の2）などの重い仕事は、
 * `apply` の中ではなく、そのあとに対象の側で行う（`afterApply`）。
 */
import type { ApprovalDecision, ApprovalSubjectType } from "@aicoop/shared/api";

/** 承認アプリに見せ、署名の payload の `summary_sha256` のもとにするもの */
export interface ApprovalSubject {
  readonly type: ApprovalSubjectType;
  readonly id: string;
  /** いまの状態（hold なら pending_owner など） */
  readonly status: string;
  /** オーナーの承認を待っているか（pending_owner のときだけ true） */
  readonly awaitingOwner: boolean;
  /** 承認アプリに表示する要約（`summary_sha256` = この値の正規化JSON の SHA-256） */
  readonly summary: unknown;
}

export interface ApprovalTarget {
  readonly type: ApprovalSubjectType;
  /** 対象が無ければ undefined */
  describe(id: string): ApprovalSubject | undefined;
  /**
   * 署名を確かめたあと、`approvals` の記録と同じトランザクションの中で呼ぶ。
   * 状態を変え（hold → approved・rejected、grant → active・rejected）、監査ログを書き、変わったあとの状態を返す。
   * もう承認を待っていなければ例外（決定は効力を持たない）
   */
  apply(id: string, decision: ApprovalDecision, by: `owner:${string}`): { readonly status: string };
  /** トランザクションのあとに呼ぶ（保留の再送など）。失敗しても承認の記録は残る */
  afterApply?(id: string, decision: ApprovalDecision): Promise<void>;
}

export type ApprovalTargets = Partial<Record<ApprovalSubjectType, ApprovalTarget>>;
