import type { ImageMetadata } from "astro";
import chania from "../../assets/profile/chania.jpg";
import eisbach from "../../assets/profile/eisbach.jpg";
import garden from "../../assets/profile/garden.jpg";
import guitars from "../../assets/profile/guitars.jpg";
import jungle from "../../assets/profile/king-of-the-jungle.jpg";
import lavaLamp from "../../assets/profile/lava-lamp.jpg";
import ovie from "../../assets/profile/ovie.jpg";
import printer from "../../assets/profile/printer.jpg";
import sourdough from "../../assets/profile/sourdough.jpg";
import tacos from "../../assets/profile/tacos.jpg";

// The Profile sheet's words and photos. Captions follow the user's board
// (portfolioDesign/1.png) almost word for word; only spelling was fixed
// ("graden", "homeade", "Bumbu Labs Pls" → Bambu Lab P1S, "Eisbachwell" → Eisbachwelle).
// The photo files were rotated upright and stripped of their metadata (GPS included)
// before they were added to the repo.

export interface Photo {
  src: ImageMetadata;
  alt: string;
  caption: string;
  /** Where to keep the subject when the photo is cropped to the strip's frame. */
  focus?: string;
}

export const INTRO =
  "Hi, I’m Ridge, a software engineer with experience building production claims processing systems for the Department of Veterans Affairs. I like building innovative, open-source, continuous learning agentic systems. Among many other things. If you’d like, check out some of my photos to get to know me better. Thanks for stopping by!";

export const PHOTOS: Photo[] = [
  {
    src: tacos,
    alt: "Four steak tacos on a white plate, topped with red salsa and crumbled cheese.",
    caption:
      "Roasted tortilla, medium rare NY strip, sautéed onions and mushrooms, homemade salsa roja, cotija cheese.",
  },
  {
    src: eisbach,
    alt: "A surfer riding the standing wave of a fast green river in a city park, with crowds watching from the banks.",
    caption:
      "The Eisbachwelle in München, Deutschland. Large crowds gather as locals surf the river.",
  },
  {
    src: chania,
    alt: "Ridge standing on an old stone harbour wall with arms spread wide, a lighthouse and blue sea behind him.",
    caption: "Χανιά (Chania, Crete). A sunny day on the busy harbor’s sea wall.",
    focus: "60% 50%",
  },
  {
    src: ovie,
    alt: "Ridge crouching beside his golden retriever puppy, Ovie, by the water at sunset.",
    caption:
      "My dog Ovie and I. Here, Ovie is 3 months old. Her breed is a field golden retriever.",
    focus: "55% 50%",
  },
  {
    src: garden,
    alt: "Green and red chili peppers, orange habaneros and herbs laid out on a white towel beside an empty glass jar.",
    caption: "Fresh vegetables from my garden. Soon to be prepared for fermentation.",
  },
  {
    src: printer,
    alt: "A Bambu Lab 3D printer with a four-spool AMS filament unit on top.",
    caption: "A Bambu Lab P1S 3D printer. With AMS equipped.",
  },
  {
    src: guitars,
    alt: "Three guitars on a wooden stand: a sunburst electric, a cream electric and an acoustic.",
    caption:
      "From left to right: Epiphone Les Paul, Sire Larry Carlton Stratocaster, Martin acoustic.",
  },
  {
    src: lavaLamp,
    alt: "A blue and purple lava lamp glowing against an orange-lit brick wall.",
    caption: "There is something about a lava lamp that I appreciate. I think it’s the nostalgia.",
  },
  {
    src: sourdough,
    alt: "Two slices of toasted homemade sourdough with a dark spread, beside a butter knife.",
    caption: "Homemade sourdough with Smashfoods superfood spread.",
  },
  {
    src: jungle,
    alt: "A hyper-realistic pencil drawing of a big cat’s open mouth, fangs bared and tongue out.",
    caption:
      "King of the Jungle, by JOV_97 on Reddit. I did not draw this. But hyper realistic pencil art is super cool.",
  },
];

/**
 * The made-up journalist's profile around the user's intro (their brief: "a real
 * profile on someone written by a funny, made up journalist", clean humour only).
 * Everything here is the reporter's voice; none of it is put in Ridge's mouth.
 */
export const PROFILE = {
  publication: "The Manila Folder Review",
  section: "Profiles",
  issue: "Vol. 1, No. 1",
  dek: "A software engineer who builds AI that checks other AI’s homework, and who also, it turns out, ferments peppers.",
  reporter: "Marjorie Inkwell",
  reporterRole: "staff correspondent",
  dateline: "Charleston, S.C.",
  filed: "2026-11-02",
  polaroid: "The subject, with his editor, Ovie.",
  notes: [
    "Arrived on time. Had written tests for the interview.",
    "Lists fermentation as a hobby. I checked: the peppers are real.",
    "Ovie tried to eat my notepad. Ovie was not reprimanded. Ovie is a very good girl.",
  ],
};
