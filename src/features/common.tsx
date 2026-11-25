import { createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApprovalDialog, Button, type Approver } from "@hostry/ui-kit";
import { useApp } from "./app-state";

/**
 * Manager approval and own-PIN action proof (RS08). One dialog is the whole confirmation: the member who holds the
 * permission re-enters their own PIN; one who does not picks a manager who does and that manager enters theirs. The approver
 * never becomes the session user.
 */
export function ProofHost(): JSX.Element {
  const app = useApp();
  const [approvers, setApprovers] = createSignal<Approver[]>([]);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [ownPin, setOwnPin] = createSignal(false);

  createEffect(
    () => app.proof(),
    (req) => {
      setError(undefined);
      if (!req) return;
      const me = app.session()?.memberId ?? "";
      const own = app.can(req.permission);
      setOwnPin(own);
      if (own) {
        setApprovers([]);
        return;
      }
      void app.rt.identity.approversFor(req.permission, me).then((list) => setApprovers(list.map((m) => ({ id: m.memberId, name: m.displayName, role: app.t(`role.${m.role}`) }))));
    },
  );

  const submit = async (r: { approverId: string | undefined; pin: string }) => {
    const req = app.proof();
    const me = app.session()?.memberId;
    if (!req || !me) return;
    if (ownPin()) {
      if (await app.rt.identity.confirmOwnPin(me, r.pin)) app.resolveProof({ ok: true });
      else setError(app.t("login.wrong"));
      return;
    }
    if (!r.approverId) return;
    const res = await app.rt.identity.approve(r.approverId, r.pin, req.permission, me, { ...(req.target ? { target: req.target } : {}), ...(req.reason ? { reason: req.reason } : {}) });
    if (res.ok) app.resolveProof({ ok: true, approvalId: res.approvalId });
    else setError(app.t(res.reason === "same" ? "approval.same" : res.reason === "not_allowed" ? "error.permission" : "login.wrong"));
  };

  return (
    <ApprovalDialog
      open={app.proof() !== undefined}
      title={ownPin() ? app.t("approval.proof.title") : app.t("approval.title")}
      {...(app.proof()?.summary ? { summary: app.proof()?.summary } : {})}
      approvers={approvers()}
      {...(error() ? { error: error() } : {})}
      data-testid="approval-dialog"
      onSubmit={(r) => void submit(r)}
      onClose={() => app.resolveProof({ ok: false })}
    />
  );
}

/** Back button used by every non-root screen. */
export function BackButton(props: { label?: string }): JSX.Element {
  const app = useApp();
  return (
    <Button variant="secondary" data-testid="back" onClick={() => app.back()}>
      {props.label ?? app.t("common.back")}
    </Button>
  );
}

/** Plain empty-state line. */
export function Empty(props: { text: string; testid?: string }): JSX.Element {
  return (
    <p class="hy-empty-line" data-testid={props.testid ?? "empty"}>
      {props.text}
    </p>
  );
}
