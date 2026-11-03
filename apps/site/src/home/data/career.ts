// The Edu x Exp sheet: the resume as a document, the timeline, and the logo wall.
//
// The resume text mirrors ~/dev/resume/my-resume.html (2026-11-02). Dates follow the
// user's board, which they confirmed over the resume on 2026-11-02: Savannah River
// from 2017, GEL from 2019. The resume itself is updated to match once the site is
// approved (tasks/todo.md, M9). Timeline notes only restate facts from the resume.

export const RESUME_PDF = "/ridge-gleaton-resume.pdf";

export interface Job {
  org: string;
  context: string;
  role: string;
  where: string;
  when: string;
  bullets: string[];
}

export const RESUME = {
  name: "Ridge Gleaton",
  headline: "Software Engineer: Python, data pipelines and AI-assisted development",
  contact: [
    { label: "Charleston, SC" },
    { label: "ridgeygleat@gmail.com", href: "mailto:ridgeygleat@gmail.com" },
    { label: "linkedin.com/in/gleator", href: "https://www.linkedin.com/in/gleator/" },
    { label: "github.com/Gleato", href: "https://github.com/Gleato" },
  ],
  summary:
    "Software developer with 3+ years at Booz Allen Hamilton on the VA’s Veterans Benefits Management System (VBMS). Specializes in Python-driven production data analysis, Kafka event pipelines, and full-stack services on Kubernetes. Daily practitioner of agentic, AI-assisted development with Claude Code, Codex, and Copilot, applying it to legacy modernization at work and to Lazaret, an open-source AI security gateway.",
  experience: [
    {
      org: "Booz Allen Hamilton",
      context: "Client: U.S. Department of Veterans Affairs",
      role: "Software Developer II",
      where: "Remote",
      when: "Jul 2022 – Present",
      bullets: [
        "Develop on a 3-person team within a ~40-engineer program modernizing VBMS, the system of record VA staff use to process 3M+ veterans’ disability claims a year.",
        "Root-caused silent production data loss of up to ~100 messages/day amid 1M+ message Kafka consumer lag; wrote Python scripts that pulled OpenSearch data from every pipeline stage and reconciled it against production database queries, isolating the failure to Kafka tombstone handling and presenting findings to tech leads that drove the fix.",
        "Modernizing a legacy VA proxy service from Java 8 to Java 25 and Spring Boot using Booz Allen’s multi-agent, spec-driven development (SDD) harness, with agents working in phases from spec to tested feature.",
        "Defined and validated Kafka message schemas for stream processors as new topics were onboarded, keeping malformed events from reaching downstream consumers.",
        "Built features for the Collections and Activator React micro-frontends used by internal VA staff, and extended the Express REST APIs behind them, documented with Swagger/OpenAPI.",
        "Managed service config, Dockerfiles, and environment settings on Kubernetes, deployed through Jenkins and Argo CD; supported production releases on deploy calls, monitoring rollouts with k9s.",
      ],
    },
    {
      org: "GEL Laboratories",
      context: "Environmental testing laboratory",
      role: "Analyst I: QA/QC, LIMS",
      where: "Charleston, SC",
      when: "2019 – 2022",
      bullets: [],
    },
    {
      org: "Savannah River Remediation",
      context: "DOE contractor, Savannah River Site",
      role: "Lab Technician",
      where: "Aiken, SC",
      when: "2017 – 2019",
      bullets: [],
    },
  ] satisfies Job[],
  project: {
    name: "Lazaret",
    context: "Open-source AI write-quarantine for web APIs",
    stack: "TypeScript, Cloudflare Workers & Durable Objects, Claude API",
    when: "Oct 2026 – Present",
    links: [
      { label: "demo.gleator.com", href: "https://demo.gleator.com" },
      { label: "github.com/Gleato/lazaret", href: "https://github.com/Gleato/lazaret" },
    ],
    bullets: [
      "Built and published on npm an edge gateway that holds API writes in a ledger, has a sandboxed Claude reviewer vet them for attacks such as prompt injection, and commits only approved writes to origin.",
      "Designed the ledger as an event-sourced state machine on Durable Objects (SQLite) with compaction, crash recovery, and HMAC-signed idempotent commits; 400+ tests include proving no write commits twice.",
      "Built a labelled 120-case eval harness: the latest live run stopped 63/63 attacks with 0/57 false positives at ~$2 per 1,000 requests; confirmed verdicts are distilled into backtested gate rules.",
      "Shipped a live demo; a Playwright suite queries its production database to prove no attack got in.",
    ],
  },
  skills: [
    ["Languages", "Python, Java, TypeScript, JavaScript, SQL"],
    ["Data & Streaming", "Apache Kafka, OpenSearch, Jupyter Notebooks, schema design & validation"],
    ["AI & LLMs", "Claude API, LLM evals, prompt-injection defense, Claude Code, Codex, Copilot"],
    [
      "Frameworks & APIs",
      "Spring Boot, React (micro-frontends), Node.js/Express, REST, Swagger/OpenAPI",
    ],
    [
      "Cloud & DevOps",
      "Kubernetes, Docker, Jenkins, Argo CD, k9s, Cloudflare Workers, Git, GitHub",
    ],
  ] as const,
  education: [
    { org: "Western Governors University", detail: "B.S. Computer Science", when: "2022" },
  ],
};

export interface Milestone {
  year: string;
  title: string;
  note: string;
  kind: "school" | "work" | "build";
}

/** High school graduation to now, in the order the board lists (2015 → 2026). */
export const TIMELINE: Milestone[] = [
  {
    year: "2015",
    title: "Clemson University",
    note: "Out of high school and off to Clemson to start college.",
    kind: "school",
  },
  {
    year: "2017",
    title: "Savannah River Site",
    note: "Lab Technician for Savannah River Remediation, a Department of Energy contractor at the Savannah River Site in Aiken, SC.",
    kind: "work",
  },
  {
    year: "2019",
    title: "The GEL Group",
    note: "Analyst I at GEL Laboratories, an environmental testing lab in Charleston: QA/QC and the lab’s LIMS.",
    kind: "work",
  },
  {
    year: "2022",
    title: "WGU graduate",
    note: "B.S. in Computer Science from Western Governors University.",
    kind: "school",
  },
  {
    year: "2022",
    title: "Booz Allen Hamilton",
    note: "Software Developer on the VA’s VBMS, the system staff use to process 3M+ veterans’ disability claims a year: Python data work, Kafka pipelines, React and Kubernetes.",
    kind: "work",
  },
  {
    year: "2026",
    title: "Lazaret",
    note: "Designed, built and shipped Lazaret: an AI write-quarantine for web APIs, open source on GitHub and npm, with a live demo.",
    kind: "build",
  },
];
