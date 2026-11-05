// The Edu x Exp sheet: the resume PDF's path and the timeline.
//
// The PDF is built from ~/dev/resume/my-resume.html. Dates follow the user's board, which
// they confirmed over the resume on 2026-11-02: Savannah River from 2017, GEL from 2019.
// Timeline notes only restate facts from the resume, so update them when it changes.

export const RESUME_PDF = "/ridge-gleaton-resume.pdf";

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
