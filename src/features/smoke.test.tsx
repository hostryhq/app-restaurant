import { describe, expect, it } from "vitest";
import { find, mountApp, queryById, text, until } from "../test/ui";

describe("smoke", () => {
  it("shows the lock screen, signs a waiter in on a handheld, opens a table and adds an item with one tap", async () => {
    const ui = await mountApp({ deviceKind: "waiter" });
    expect(queryById("lock-screen")).not.toBeNull();
    await ui.login("Ravi");
    expect(await find("floor-screen")).toBeTruthy();
    await ui.tap("table-T1");
    await find("order-screen");
    await ui.tap("item-12");
    await until(() => expect(text("order-total")).toContain("84.00"));
    await ui.tap("send");
    await until(() => expect(queryById("send")).toBeNull());
    expect(ui.rt.fakes.kitchen.printed).toHaveLength(1);
  });
});
