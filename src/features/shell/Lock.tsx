import { createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, InlineAlert, PinPad, UserTile } from "@hostry/ui-kit";
import type { Member } from "../../data/ports";
import { useApp } from "../app-state";

/**
 * RS01: tap your name, enter your PIN. One generic message for a wrong PIN, a delay after 5 wrong, a lock after 10 (RM-A7).
 * Sign-in works offline from the offline pack. The pack expiring disables the tiles but never interrupts an open session.
 */
export function Lock(): JSX.Element {
  const app = useApp();
  const [members, setMembers] = createSignal<Member[]>([]);
  const [picked, setPicked] = createSignal<Member | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const expired = () => Date.parse(app.rt.identity.packExpiresAt()) <= app.nowMs();

  onSettled(() => {
    void app.rt.identity.members().then(setMembers);
  });

  const submit = async (pin: string) => {
    const m = picked();
    if (!m || busy()) return;
    setBusy(true);
    const r = await app.signIn({ memberId: m.memberId, pin });
    setBusy(false);
    if (r.ok) return;
    setError(r.reason === "delay" ? app.t("login.delay", { s: r.waitSeconds ?? 60 }) : r.reason === "locked" ? app.t("login.locked") : r.reason === "pack_expired" ? app.t("login.expired") : app.t("login.wrong"));
  };

  return (
    <main class="app-lock" data-testid="lock-screen">
      <h1>{app.t("login.title")}</h1>
      <Show when={expired()}>
        <InlineAlert kind="warning" data-testid="login-expired">
          {app.t("login.expired")}
        </InlineAlert>
      </Show>
      <Show
        when={picked()}
        fallback={
          <div class="app-tiles" role="group" aria-label={app.t("login.title")}>
            <For each={members()}>
              {(m) => (
                <UserTile
                  name={m.displayName}
                  role={app.t(`role.${m.role}`)}
                  data-testid={`login-user-${m.memberId}`}
                  onSelect={() => {
                    if (expired()) return;
                    setError(undefined);
                    setPicked(m);
                  }}
                />
              )}
            </For>
          </div>
        }
      >
        <p data-testid="login-name">{picked()?.displayName}</p>
        <PinPad data-testid="login-pin" {...(error() ? { error: error() } : {})} disabled={busy()} onComplete={(pin) => void submit(pin)} />
        <Button
          variant="secondary"
          data-testid="login-back"
          onClick={() => {
            setPicked(undefined);
            setError(undefined);
          }}
        >
          {app.t("common.back")}
        </Button>
      </Show>
    </main>
  );
}
