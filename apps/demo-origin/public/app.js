// Tidewater Support UI. Plain modules, no build step.
//
// Every request goes to the same origin, which is Lazaret's gateway. Writes come
// back as 202 + a receipt while they're held for review; the UI keeps those in a
// per-persona outbox and polls `/__lazaret/receipts/:id` until each one settles.
//
// All user-written text is rendered with textContent, never innerHTML: the author
// sees their own unvetted writes (that's the read-your-writes overlay), so a payload
// must not run even for them.

const PASSWORD = "tidewater-demo"; // public demo credential, seeded in migrations/0002
const PERSONAS = {
  mara: { email: "mara@tidewater.test", name: "Mara", role: "customer" },
  theo: { email: "theo@tidewater.test", name: "Theo", role: "customer" },
  sam: { email: "sam@tidewater.test", name: "Sam", role: "agent" },
};
const STATUS = {
  PENDING: ["Waiting for review", ""],
  APPROVED: ["Approved, delivering", ""],
  COMMITTED: ["Delivered", "delivered"],
  DROPPED: ["Rejected by review", "rejected"],
  QUARANTINED: ["Held for a person to check", ""],
};
const FINAL = new Set(["COMMITTED", "DROPPED", "QUARANTINED"]);

const app = document.getElementById("app");
const state = { persona: null, token: null, selected: null, tickets: [], timer: null };

// ── Small helpers ───────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

const money = (cents) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortReceipt = (r) => `Receipt ${r.slice(0, 8)}`;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  // On the public demo, writes need a Turnstile pass (apps/demo-lazaret guard.ts).
  // The guard's check page sets it as a cookie and sends the visitor back here.
  if (res.status === 401 && json?.error === "demo_pass_required") {
    location.assign(`/demo/verify?return=${encodeURIComponent(location.pathname + location.hash)}`);
  }
  return { status: res.status, json };
}

function statusBadge(status) {
  const [label, cls] = STATUS[status] ?? STATUS.PENDING;
  return h("span", { class: `status ${cls}` }, label);
}

// ── Outbox: writes this persona sent that are (or were) held for review ─────

const outboxKey = () => `tw-outbox-${state.persona}`;
const outbox = () => store.get(outboxKey(), []);
function saveOutbox(items) {
  store.set(outboxKey(), items);
}
function remember(item) {
  saveOutbox([...outbox(), { status: "PENDING", sentAt: Date.now(), ...item }]);
}

async function pollReceipts() {
  const items = outbox();
  let changed = false;
  for (const item of items.filter((i) => !FINAL.has(i.status))) {
    const { status, json } = await api("GET", `/__lazaret/receipts/${item.receipt}`);
    if (status === 200 && json.status !== item.status) {
      item.status = json.status;
      changed = true;
      if (json.status === "COMMITTED") toast(`Your ${item.kind} was delivered.`);
      if (json.status === "DROPPED") toast(`Your ${item.kind} was rejected by review.`);
    }
  }
  if (changed) {
    saveOutbox(items);
    await refresh();
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

async function signIn(persona) {
  state.persona = persona;
  state.selected = null;
  state.token = store.get(`tw-token-${persona}`, null);
  for (const b of document.querySelectorAll("[data-persona]"))
    b.setAttribute("aria-pressed", String(b.dataset.persona === persona));

  if (!state.token || (await api("GET", "/api/me")).status !== 200) {
    state.token = null;
    const { status, json } = await api("POST", "/api/login", {
      email: PERSONAS[persona].email,
      password: PASSWORD,
    });
    if (status !== 200) {
      toast(`Couldn't sign in (${status}). Try again in a moment.`);
      return;
    }
    state.token = json.token;
    store.set(`tw-token-${persona}`, json.token);
  }
  clearInterval(state.timer);
  state.timer = setInterval(pollReceipts, 3000);
  await refresh();
  app.focus();
}

// ── Rendering ───────────────────────────────────────────────────────────────

async function refresh() {
  const { status, json } = await api("GET", "/api/tickets");
  if (status !== 200) {
    app.replaceChildren(h("p", {}, `Couldn't load tickets (${status}).`));
    return;
  }
  state.tickets = json.tickets;
  const isAgent = PERSONAS[state.persona].role === "agent";
  app.replaceChildren(
    h(
      "div",
      { class: "workspace" },
      ticketList(isAgent),
      isAgent ? h("div", { class: "stack" }, await detail(), await assistant()) : await detail(),
    ),
  );
}

function ticketList(isAgent) {
  // Origin data is above the tide line. Below it: this persona's held writes, from
  // the overlay (pending) and the outbox (rejected ones, which the overlay drops).
  const delivered = state.tickets.filter((t) => !t._lazaret);
  const held = state.tickets.filter((t) => t._lazaret);
  const heldReceipts = new Set(held.map((t) => t._lazaret.receipt));
  // Settled without being delivered: the overlay no longer shows these.
  const rejected = outbox().filter(
    (i) =>
      i.kind === "ticket" &&
      (i.status === "DROPPED" || i.status === "QUARANTINED") &&
      !heldReceipts.has(i.receipt),
  );

  const row = (t, { pending = false, rejected: isRejected = false } = {}) => {
    const id = pending || isRejected ? (t._lazaret?.receipt ?? t.receipt) : t.id;
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: `ticket-row${t.status === "DROPPED" ? " rejected" : ""}`,
          "aria-current": String(state.selected === id),
          onclick: () => {
            state.selected = id;
            refresh();
          },
        },
        h("span", { class: "subject" }, t.subject),
        h(
          "span",
          { class: "meta" },
          isRejected
            ? STATUS[t.status][0]
            : pending
              ? "Waiting for review"
              : `${isAgent ? `${t.customer}, ` : ""}${t.status}, ${when(t.updated_at)}`,
        ),
      ),
    );
  };

  return h(
    "section",
    { "aria-labelledby": "list-title" },
    h("h2", { id: "list-title" }, isAgent ? "Support queue" : "Your tickets"),
    isAgent
      ? null
      : h(
          "button",
          {
            type: "button",
            class: "button",
            onclick: () => {
              state.selected = "new";
              refresh();
            },
          },
          "New ticket",
        ),
    h(
      "ul",
      { class: "tickets", style: "margin-top:12px" },
      delivered.length
        ? delivered.map((t) => row(t))
        : h("li", { class: "muted" }, "No tickets yet."),
    ),
    held.length || rejected.length
      ? h(
          "div",
          { class: "held" },
          tideLine(),
          h(
            "ul",
            { class: "tickets" },
            held.map((t) => row(t, { pending: true })),
            rejected.map((i) => row(i, { rejected: true })),
          ),
        )
      : null,
  );
}

function tideLine() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 10");
  svg.setAttribute("preserveAspectRatio", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M0 5 Q 7.5 0 15 5 T 30 5 T 45 5 T 60 5 T 75 5 T 90 5 T 105 5 T 120 5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return h(
    "div",
    { class: "tide" },
    svg,
    h("p", {}, "Held by Lazaret. Only you can see these; they reach Tidewater once review passes."),
  );
}

async function detail() {
  const sel = state.selected;
  if (sel === "new") return newTicketForm();
  if (!sel)
    return h(
      "section",
      { class: "pane" },
      h(
        "h1",
        {},
        PERSONAS[state.persona].role === "agent"
          ? "Pick a ticket"
          : `Hi ${PERSONAS[state.persona].name}`,
      ),
      h(
        "p",
        { class: "muted" },
        PERSONAS[state.persona].role === "agent"
          ? "Tickets appear here once Lazaret has reviewed them."
          : "Open a ticket, or pick one from your list.",
      ),
    );

  const held = state.tickets.find((t) => t._lazaret?.receipt === sel);
  const sent = outbox().find((i) => i.receipt === sel);
  if (held || (sent && sent.status !== "COMMITTED")) return heldTicket(held ?? sent, sent);

  const { status, json } = await api("GET", `/api/tickets/${encodeURIComponent(sel)}`);
  if (status !== 200)
    return h("section", { class: "pane" }, h("p", {}, "That ticket isn't available."));
  const { ticket, replies, attachments } = json;
  const local = outbox().filter(
    (i) => i.ticketId === ticket.id && i.kind !== "ticket" && i.status !== "COMMITTED",
  );
  const overlaid = new Set(replies.filter((r) => r._lazaret).map((r) => r._lazaret.receipt));

  return h(
    "section",
    { class: "pane", "aria-labelledby": "ticket-title" },
    h("h1", { id: "ticket-title" }, ticket.subject),
    h("p", { class: "muted" }, `Opened ${when(ticket.created_at)}, ${ticket.status}`),
    h("p", { class: "body-text" }, ticket.body),
    attachments.length
      ? h("p", { class: "muted" }, `Attachments: ${attachments.map((a) => a.filename).join(", ")}`)
      : null,
    h(
      "ul",
      { class: "thread" },
      replies.map((r) =>
        r._lazaret
          ? h(
              "li",
              { class: "held" },
              h("span", { class: "who" }, "You"),
              " ",
              statusBadge("PENDING"),
              h("p", { class: "body-text" }, r.body),
              h("span", { class: "receipt" }, shortReceipt(r._lazaret.receipt)),
            )
          : h(
              "li",
              { class: r.author_role === "customer" ? "" : "staff" },
              h("span", { class: "who" }, r.author),
              h("span", { class: "muted" }, `, ${when(r.created_at)}`),
              h("p", { class: "body-text" }, r.body),
            ),
      ),
      local
        .filter((i) => !overlaid.has(i.receipt))
        .map((i) =>
          h(
            "li",
            { class: "held" },
            h("span", { class: "who" }, "You"),
            " ",
            statusBadge(i.status),
            h("p", { class: "body-text" }, i.body),
          ),
        ),
    ),
    replyForm(ticket.id),
  );
}

function heldTicket(t, sent) {
  const receipt = t._lazaret?.receipt ?? t.receipt;
  const status = sent?.status ?? "PENDING";
  return h(
    "section",
    { class: "pane", "aria-labelledby": "ticket-title" },
    h("h1", { id: "ticket-title" }, t.subject),
    h("p", {}, statusBadge(status), " ", h("span", { class: "receipt" }, shortReceipt(receipt))),
    h(
      "p",
      { class: "muted" },
      status === "DROPPED"
        ? "Lazaret's reviewer rejected this ticket, so it never reached Tidewater. Anything you added to it was rejected with it."
        : "Lazaret is holding this ticket until its reviewer checks it. You can already add to it; your replies wait with it.",
    ),
    h("p", { class: "body-text" }, t.body),
    status === "DROPPED" ? null : replyForm(receipt),
  );
}

function replyForm(ticketId) {
  const text = h("textarea", { id: "reply", name: "body", required: true, maxlength: 5000 });
  return h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const button = e.submitter;
        button.disabled = true;
        const { status, json } = await api(
          "POST",
          `/api/tickets/${encodeURIComponent(ticketId)}/replies`,
          {
            body: text.value,
          },
        );
        button.disabled = false;
        if (status === 202) {
          remember({ receipt: json.receipt, kind: "reply", ticketId, body: text.value });
          toast("Reply sent. It's waiting for review.");
          await refresh();
        } else toast(`Reply not sent (${json?.error ?? status}).`);
      },
    },
    h("label", { for: "reply" }, "Reply"),
    text,
    h("button", { class: "button", type: "submit" }, "Send reply"),
  );
}

function newTicketForm() {
  const subject = h("input", { id: "subject", name: "subject", required: true, maxlength: 120 });
  const body = h("textarea", { id: "body", name: "body", required: true, maxlength: 5000 });
  return h(
    "section",
    { class: "pane", "aria-labelledby": "new-title" },
    h("h1", { id: "new-title" }, "New ticket"),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          e.submitter.disabled = true;
          const { status, json } = await api("POST", "/api/tickets", {
            subject: subject.value,
            body: body.value,
          });
          e.submitter.disabled = false;
          if (status === 202) {
            remember({
              receipt: json.receipt,
              kind: "ticket",
              subject: subject.value,
              body: body.value,
            });
            state.selected = json.receipt;
            toast("Ticket sent. It's waiting for review.");
            await refresh();
          } else toast(`Ticket not sent (${json?.error ?? status}).`);
        },
      },
      h("label", { for: "subject" }, "Subject"),
      subject,
      h("label", { for: "body" }, "What's going on?"),
      body,
      h("button", { class: "button", type: "submit" }, "Send ticket"),
    ),
  );
}

// ── Agent: the AI assistant and the "Lazaret off" replay ────────────────────

async function assistant() {
  const { json } = await api("GET", "/api/agent/proposals");
  const proposals = json?.proposals ?? [];
  const replayOut = h("div", { "aria-live": "polite" });

  return h(
    "section",
    { class: "pane", "aria-labelledby": "assistant-title" },
    h("h2", { id: "assistant-title" }, "Refund assistant"),
    h(
      "p",
      { class: "muted" },
      "The assistant reads open tickets and suggests refunds. It can't pay anything out; you decide.",
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          class: "button",
          onclick: async (e) => {
            e.target.disabled = true;
            const { status, json: run } = await api("POST", "/api/agent/run");
            e.target.disabled = false;
            if (status === 503)
              toast("The assistant needs an Anthropic API key on Tidewater's origin.");
            else if (status !== 200) toast(`The assistant didn't run (${status}).`);
            else
              toast(
                `The assistant checked ${run.queue.length} ticket${run.queue.length === 1 ? "" : "s"}.`,
              );
            await refresh();
          },
        },
        "Check open tickets",
      ),
    ),
    proposals.length
      ? h(
          "div",
          {},
          proposals.map((p) =>
            h(
              "div",
              { class: "proposal" },
              h(
                "div",
                {},
                h("h3", {}, p.subject),
                h("span", { class: "muted" }, `${p.customer}: ${p.reason}`),
              ),
              p.decision === "propose_refund"
                ? h(
                    "div",
                    { class: "actions" },
                    h("span", { class: "amount" }, money(p.amount_cents)),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "button quiet",
                        onclick: async (e) => {
                          e.target.disabled = true;
                          const { status } = await api(
                            "POST",
                            `/api/accounts/${p.account_id}/credits`,
                            {
                              amount_cents: p.amount_cents,
                              reason: `Refund for "${p.subject}"`,
                            },
                          );
                          toast(
                            status === 201
                              ? `Credited ${money(p.amount_cents)} to ${p.customer}.`
                              : "Lazaret's review declined this credit.",
                          );
                        },
                      },
                      "Issue credit",
                    ),
                  )
                : h(
                    "span",
                    { class: "muted" },
                    p.decision === "escalate" ? "Needs a person" : "No refund",
                  ),
            ),
          ),
        )
      : h("p", { class: "muted" }, "No suggestions yet."),
    h("h2", { style: "margin-top:28px" }, "What if Lazaret were off?"),
    h(
      "p",
      { class: "simulated-note" },
      "A replay with a deliberately naive, scripted assistant that obeys instructions found in ticket text. It's simulated and writes nothing. Real models resist many of these attacks; the point is what reaches the assistant at all.",
    ),
    h(
      "div",
      { class: "actions" },
      [
        ["refund-hijack", "Replay the refund hijack"],
        ["refund-redirect", "Replay the refund redirect"],
      ].map(([id, label]) =>
        h(
          "button",
          { type: "button", class: "button quiet", onclick: () => replay(id, replayOut) },
          label,
        ),
      ),
    ),
    replayOut,
  );
}

async function replay(scenario, out) {
  const { status, json } = await api("GET", `/api/agent/simulate?scenario=${scenario}`);
  if (status !== 200) {
    out.replaceChildren(h("p", {}, `The replay didn't run (${status}).`));
    return;
  }
  const side = (run, off) =>
    h(
      "div",
      { class: `replay-side${off ? " off" : ""}` },
      h("h3", {}, off ? "Lazaret off (simulated)" : "Lazaret on"),
      h("p", { class: "total" }, money(run.hijacked_cents)),
      h("p", { class: "muted" }, "proposed against refund policy"),
      h(
        "ol",
        {},
        run.proposals.map((p) =>
          h(
            "li",
            { class: p.hijacked ? "hijacked" : "" },
            p.decision === "propose_refund"
              ? `${money(p.amount_cents)} to ${p.account_id}${p.hijacked ? " (hijacked)" : ""}`
              : "No refund",
          ),
        ),
      ),
    );
  out.replaceChildren(
    h("p", { class: "payload" }, json.scenario.ticket.body),
    h("div", { class: "replay-grid" }, side(json.lazaret_off, true), side(json.lazaret_on, false)),
    h(
      "p",
      { class: "simulated-note" },
      "With Lazaret on, the assistant only reads tickets that passed review. This payload is the kind of write Lazaret's reviewer drops before it reaches the database.",
    ),
  );
}

// ── Boot ────────────────────────────────────────────────────────────────────

for (const b of document.querySelectorAll("[data-persona]")) {
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => signIn(b.dataset.persona));
}
