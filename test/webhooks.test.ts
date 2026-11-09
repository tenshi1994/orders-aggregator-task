import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("параллельные доставки с дублями и не по порядку - остаётся самая новая версия", async () => {
    const orders = Array.from({ length: 10 }, () => apiOrder({ status: "pending", updatedAt: "2026-02-10T12:00:00Z" }));
    const deliveries = orders.flatMap((o) => {
      const v = [
        o,
        { ...o, status: "paid", amountPaid: 900, updatedAt: "2026-02-10T13:00:00Z" },
        { ...o, status: "paid", amountPaid: 800, updatedAt: "2026-02-10T14:00:00Z" },
        { ...o, status: "refunded", amountPaid: 800, updatedAt: "2026-02-11T10:00:00Z" },
      ];
      return [v[1], v[0], v[2], v[3], v[0], v[1], v[2], v[1]];
    });
    const results = await Promise.all(deliveries.map((v) => postWebhook(ctx.app, v)));

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().result === "created")).toHaveLength(orders.length);
    const { rows } = await ctx.db.query(`SELECT status, updated_at FROM orders WHERE id = ANY($1)`, [orders.map((o) => o.id)]);
    expect(rows).toHaveLength(orders.length);
    for (const r of rows) {
      expect(r.status).toBe("refunded");
      expect(r.updated_at.toISOString()).toBe("2026-02-11T10:00:00.000Z");
    }
  });

  it("новая версия со сменой скидки обновляет оплаченную сумму", async () => {
    const o = apiOrder({ amount: 1000, discountPercent: 3, amountPaid: 970 });
    await postWebhook(ctx.app, o);
    await postWebhook(ctx.app, { ...o, discountPercent: 10, amountPaid: 900, updatedAt: "2026-02-10T13:00:00Z" });
    await postWebhook(ctx.app, o);
    const { rows } = await ctx.db.query(`SELECT amount_paid_kop FROM orders WHERE id = $1`, [o.id]);
    expect(Number(rows[0].amount_paid_kop)).toBe(90000);
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });
});
