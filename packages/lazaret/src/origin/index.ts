// Origin-side helpers, published as `@gleator/lazaret/origin`. This is a small,
// dependency-free import for the protected application, which only needs to verify
// that requests came through Lazaret.
//
//   const check = await verifyLazaretRequest(request, env.LAZARET_SIGNING_SECRET);
//   if (!check.ok) return new Response("Forbidden", { status: 403 });
//   // check.id is the Ledger entry id: use it as an idempotency key for writes.

export {
  HEADER_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  type VerifyResult,
  verifyLazaretRequest,
} from "../commit/sign";
