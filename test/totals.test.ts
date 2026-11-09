import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { date: "2026-02-09", total: 0 },
      { date: "2026-02-10", total: 1000 },
      { date: "2026-02-11", total: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toMatchObject([{ date: "2026-02-10", total: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toMatchObject([{ date: "2026-02-10", total: 800 }]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /customers/:id/daily-totals - скидки", () => {
  it("gross - до скидки, net - оплачено, discount - разница, total = gross", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2500, gross: 2500, discount: 412.5, net: 2087.5 }]);
  });

  it("заказ без полей скидки считается оплаченным полностью", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000 }));
    await postWebhook(ctx.app, apiOrder({ amount: 500, discountPercent: 0, amountPaid: 500 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 1500, gross: 1500, discount: 0, net: 1500 }]);
  });

  it("суммы строками и с копейками - точно до копейки", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: "1139.00", discountPercent: "10", amountPaid: 1025.1 }));
    await postWebhook(ctx.app, apiOrder({ amount: 1102, discountPercent: 7, amountPaid: "1024.86" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2241, gross: 2241, discount: 191.04, net: 2049.96 }]);
  });

  it("невалидный amountPaid", async () => {
    const res = await postWebhook(ctx.app, apiOrder({ amountPaid: "abc" }));
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /customers/:id/daily-totals - переход на летнее время", () => {
  it("день считается по смещению на момент заказа, а не на момент запроса", async () => {
    ctx.api.customers.set("c_7", "Europe/Berlin");
    await postWebhook(ctx.app, apiOrder({ customerId: "c_7", amount: 100, createdAt: "2026-03-27T22:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ customerId: "c_7", amount: 200, createdAt: "2026-03-29T22:30:00Z" }));

    const res = await dailyTotals(ctx.app, "c_7", "2026-03-27", "2026-03-30");
    expect(res.json()).toMatchObject([
      { date: "2026-03-27", total: 100 },
      { date: "2026-03-28", total: 0 },
      { date: "2026-03-29", total: 0 },
      { date: "2026-03-30", total: 200 },
    ]);
  });
});
