-- Оплачено со скидкой, в копейках. NULL - строка сохранена до появления скидок в API.
ALTER TABLE orders ADD COLUMN amount_paid_kop BIGINT;
