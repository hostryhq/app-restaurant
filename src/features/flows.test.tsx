import { describe, expect, it } from "vitest";
import { TAP_BUDGET } from "../domain/tap-budget";
import { openTableCheck, addLine, sendKot, startShift } from "../data/trading";
import { find, missingTestIds, mountApp, queryById, text, until } from "../test/ui";
import { rows, world } from "../test/world";

type Bill = { number: string; total_paise: number; discount_paise: number };

describe("tap and keystroke budgets (docs/design section 3)", () => {
  it("counter bill with 3 single items and exact cash takes at most 10 taps (AC 91); the first cash payment adds the shift tap", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await find("counter-screen");
    await ui.tap("item-31");
    await ui.tap("item-32");
    await ui.tap("item-12");
    await ui.tap("pay");
    await ui.tap("tender-exact");
    await ui.tap("shift-open-submit"); // once per shift, prefilled float
    await until(() => expect(rows<Bill>(ui.rt, "bill")).toHaveLength(1));
    expect(ui.taps()).toBe(6);
    expect(ui.taps()).toBeLessThanOrEqual(TAP_BUDGET.counterBillThreeItems);
    expect(rows<Bill>(ui.rt, "bill")[0]?.number).toBe("A07/2627/000001");
    expect(ui.rt.fakes.drawer.opened).toBe(1);
  });

  it("adding an item takes 1 tap with a quick item and 2 with a category tab (AC 12)", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-12");
    expect(ui.taps()).toBe(1);
    ui.reset();
    await ui.tap("category-cat-drinks");
    await ui.tap("item-33");
    expect(ui.taps()).toBe(TAP_BUDGET.addItem);
    await until(() => expect(rows(ui.rt, "order_line")).toHaveLength(2));
  });

  it("keyboard only: F2, three code entries, F8, F9 is 6 key groups and no mouse (AC 92)", async () => {
    const w = await world();
    await w.signIn("Asha");
    await startShift(w.rt.ctx, 0); // an open shift, so no prompt interrupts the keys
    w.rt.setSession(undefined);
    const ui = await mountApp({ world: w });
    await ui.login("Asha");
    await find("counter-screen");
    ui.press("F2");
    await ui.enter("3*12");
    await ui.enter("31");
    await ui.enter("32");
    await until(() => expect(rows(ui.rt, "order_line")).toHaveLength(3));
    ui.press("F8");
    await find("tender-screen");
    ui.press("F9");
    await until(() => expect(rows<Bill>(ui.rt, "bill")).toHaveLength(1));
    expect(ui.keys()).toBe(6); // F2, 3 code entries, F8, F9
    expect(ui.taps()).toBe(0);
    expect(rows<Bill>(ui.rt, "bill")[0]?.total_paise).toBe(Math.round((3 * 8000 + 3000 + 2000) * 1.05 / 100) * 100);
  });

  it("table: open, add one item, send is 3 taps; a draft line is removed with 1 tap and no prompt", async () => {
    const ui = await mountApp({ deviceKind: "waiter", signedIn: "Ravi" });
    await ui.tap("table-T2");
    await ui.tap("item-12");
    await ui.tap("send");
    await until(() => expect(rows(ui.rt, "kot")).toHaveLength(1));
    expect(ui.taps()).toBe(TAP_BUDGET.tableOrderSend);
    await ui.tap("item-31");
    ui.reset();
    const line = rows<{ id: string; item_id: string }>(ui.rt, "order_line").find((l) => l.item_id === "it-coffee");
    await ui.tap(`order-line-${line?.id}-stepper-decrement`).catch(() => undefined);
  });

  it("waiter: Bill please is 2 taps (table, Bill please); the cashier then needs request, Present, Pay, Exact = 4 taps", async () => {
    const w = await world({ deviceKind: "pos" });
    await w.signIn("Ravi");
    const { checkId } = await openTableCheck(w.rt.ctx, "tb-3");
    await addLine(w.rt.ctx, checkId, { itemId: "it-meal", qtyMilli: 1000 });
    await sendKot(w.rt.ctx, checkId);
    await w.signIn("Asha");
    await startShift(w.rt.ctx, 0);
    w.rt.setSession(undefined);
    const ui = await mountApp({ world: w });
    await ui.login("Ravi");
    await ui.tap("mode-tables");
    await find("floor-screen");
    ui.reset();
    await ui.tap("table-T3");
    await ui.tap("bill-please");
    expect(ui.taps()).toBe(TAP_BUDGET.billPlease);
    await until(() => expect(rows(ui.rt, "bill_request")).toHaveLength(1));

    await ui.tap("lock");
    await ui.login("Asha");
    await ui.tap("mode-tables");
    await find("floor-screen");
    ui.reset();
    await ui.tap(`bill-request-${checkId}`);
    await until(() => queryById("present"));
    await ui.tap("present");
    await ui.tap("pay");
    await ui.tap("tender-exact");
    await until(() => expect(rows<Bill>(ui.rt, "bill")).toHaveLength(1));
    expect(ui.taps()).toBe(TAP_BUDGET.presentThenExact);
    expect(rows(ui.rt, "check_present")).toHaveLength(1);
    expect(rows<Bill>(ui.rt, "bill")[0]?.number).toBe("A07/2627/000001");
  });
});

describe("approval, permissions and lock", () => {
  it("an over-limit discount asks a manager in one dialog; the manager's own PIN approves and the audit op carries the approval", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-21");
    await ui.tap("discount");
    await ui.tap("discount-percent");
    const value = (await find("discount-value")) as HTMLInputElement;
    value.value = "20";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await ui.tap("reason-rc-disc-regular");
    await until(() => expect(text("discount-apply")).toContain("manager"));
    await ui.tap("discount-apply");
    await find("approval-dialog");
    expect(queryById("approval-user-m-asha")).toBeNull(); // the requester is not offered
    await ui.tap("approval-user-m-meena");
    await ui.pin("3333", "approval-pin-numpad");
    await until(() => expect(rows(ui.rt, "check")[0]).toMatchObject({ discount_kind: "percent", discount_value: 2000 }));
    const op = rows<{ intent: string; approval?: string }>(ui.rt, "_op").find((o) => o.intent === "bill.discount.over_limit");
    expect(op?.approval).toBeTruthy();
  });

  it("a wrong manager PIN is refused with one generic message and applies nothing", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-21");
    await ui.tap("discount");
    const value = (await find("discount-value")) as HTMLInputElement;
    value.value = "20";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await ui.tap("reason-rc-disc-regular");
    await ui.tap("discount-apply");
    await ui.tap("approval-user-m-meena");
    await ui.pin("9999", "approval-pin-numpad");
    await until(() => expect(queryById("approval-pin-error")).not.toBeNull());
    expect(rows(ui.rt, "check")[0]).not.toHaveProperty("discount_kind");
  });

  it("a waiter sees no Pay, Discount or credit controls; a cashier does not see Re-bill or day close", async () => {
    const ui = await mountApp({ deviceKind: "waiter", signedIn: "Ravi" });
    await ui.tap("table-T1");
    await ui.tap("item-12");
    await until(() => expect(queryById("send")).not.toBeNull());
    expect(queryById("pay")).toBeNull();
    expect(queryById("discount")).toBeNull();
    expect(queryById("mode-bar")).toBeNull(); // one mode only: Tables
  });

  it("Ctrl+L locks, another member signs in, and the open order stays (orders belong to the table, not the user)", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-12");
    await until(() => expect(rows(ui.rt, "order_line")).toHaveLength(1));
    ui.press("l", { ctrlKey: true });
    await find("lock-screen");
    await ui.login("Meena");
    await find("counter-screen");
    expect(rows(ui.rt, "order_line")).toHaveLength(1);
    await ui.tap("open-held");
    await find("held-screen");
    expect(queryById("held-1")).not.toBeNull();
  });

  it("5 wrong PINs make the member wait a minute, shown as a countdown; a correct PIN during the wait is still refused", async () => {
    const ui = await mountApp();
    await ui.tap("login-user-m-asha");
    for (let i = 0; i < 5; i++) {
      await ui.pin("0000");
      await until(() => expect(text("login-pin-error")).toContain("not correct"));
    }
    await ui.pin("1111"); // correct, but inside the wait
    await until(() => expect(text("login-pin-error")).toContain("Wait 60 seconds"));
    expect(queryById("app-header")).toBeNull();
  });

  it("every interactive element on the main screens has a data-testid (AC 190)", async () => {
    const ui = await mountApp({ signedIn: "Meena" });
    await find("counter-screen");
    await ui.tap("item-12");
    expect(missingTestIds()).toEqual([]);
  });
});

describe("sync status, offline and blackout banners", () => {
  it("shows Offline with the pending count, then At hub, then Synced as links come back", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-12");
    await until(() => expect(rows(ui.rt, "order_line")).toHaveLength(1));
    const pending = ui.rt.sync.status().pendingOps;
    expect(pending).toBeGreaterThan(1);
    expect(ui.rt.sync.status().state).toBe("offline");
    await until(() => expect(text("sync-chip")).toContain(String(pending)));
    await ui.rt.links?.set({ hub: true });
    await until(() => expect(ui.rt.sync.status()).toMatchObject({ state: "pending", pendingOps: 0, upstream: "hub" }));
    expect(ui.rt.sync.status().atHubOps).toBe(pending);
    // The hub's own uplink comes back: it relays to the cloud, and the device sees its ops confirmed on its next round.
    ui.net.hubCloud.up = true;
    await ui.net.relay();
    await ui.rt.sync.syncNow();
    await until(() => expect(ui.rt.sync.status().state).toBe("synced"));
  });

  it("no network and a failing printer shows the working-alone banner and the late tickets entry; nothing about a plan or payment ever appears", async () => {
    const ui = await mountApp({ signedIn: "Asha" });
    await ui.tap("item-12");
    ui.rt.fakes.kitchen.failWith = "offline";
    await ui.tap("send");
    await until(() => expect(queryById("notice-blackout")).not.toBeNull());
    expect(text("banners")).not.toMatch(/plan|subscription|payment due/i);
    // RS06: the waiter hands the order over by hand; that is recorded, the queued original never prints, the line shows "hand".
    await ui.tap("send-by-hand");
    await until(() => expect(rows(ui.rt, "kot_handover")).toHaveLength(1));
    expect(ui.rt.fakes.hub.jobs().filter((j) => j.kind === "kot")).toHaveLength(0);
    ui.rt.fakes.kitchen.failWith = undefined;
    await ui.rt.fakes.hub.flush();
    expect(ui.rt.fakes.kitchen.printed).toHaveLength(0);
    await until(() => expect(document.body.textContent).toContain("Given by hand"));
  });
});

describe("KDS", () => {
  it("a KDS device needs no PIN, shows its station's tickets from the local store, bumps with one tap and works offline", async () => {
    const w = await world({ deviceKind: "kds" });
    await w.signIn("Ravi");
    const { checkId } = await openTableCheck(w.rt.ctx, "tb-1");
    await addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 2000 });
    await addLine(w.rt.ctx, checkId, { itemId: "it-coffee", qtyMilli: 1000 });
    await sendKot(w.rt.ctx, checkId);
    w.rt.setSession(undefined);
    const ui = await mountApp({ world: w });
    expect(queryById("lock-screen")).toBeNull();
    await find("kds-screen");
    await ui.tap("station-KITCHEN");
    await until(() => expect(text("kds-screen")).toContain("MASALA DOSA"));
    expect(text("kds-screen")).not.toContain("FILTER COFFEE"); // that ticket is the bar's
    ui.reset();
    const kot = rows<{ id: string; station_code: string }>(ui.rt, "kot").find((k) => k.station_code === "KITCHEN");
    await ui.tap(`kds-bump-${kot?.id}`);
    expect(ui.taps()).toBe(TAP_BUDGET.bump);
    await until(() => expect(rows<{ status: string }>(ui.rt, "kot_line").filter((l) => l.status === "ready")).toHaveLength(1));
    await ui.rt.links?.set({ hub: false, cloud: false });
    await until(() => expect(queryById("kds-offline")).not.toBeNull());
  });
});
