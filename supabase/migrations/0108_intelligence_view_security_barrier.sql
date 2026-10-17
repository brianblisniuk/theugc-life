-- 0108_intelligence_view_security_barrier.sql
--
-- D190. The five public intelligence projections stay security_invoker = false.
-- They are privacy projections over relations the browser roles must not
-- select. This migration does not replace their SELECT lists or WHERE
-- clauses, and it does not grant any role a new privilege.
--
-- 0026 created hotel_public_intelligence and hotel_premium_intelligence with
-- security_invoker = false and without security_barrier. The premium WHERE
-- clause is has_premium_hotel_access(). A barrier keeps a caller predicate
-- from being evaluated under that gate, and under the public CASE projection.
-- 0056 and 0071 already set the barrier on the other three views. Restating
-- both options here locks the catalog without rewriting the queries.

alter view public.hotel_public_intelligence
  set (security_barrier = true, security_invoker = false);

alter view public.hotel_premium_intelligence
  set (security_barrier = true, security_invoker = false);

alter view public.network_hotel_public
  set (security_barrier = true, security_invoker = false);

alter view public.hotel_metric_signal_public
  set (security_barrier = true, security_invoker = false);

alter view public.hotel_metric_signal_premium
  set (security_barrier = true, security_invoker = false);
