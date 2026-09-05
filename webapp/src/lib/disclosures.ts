import crypto from "node:crypto";

// ESIGN / UETA consumer disclosures (v0.2).
//
// 15 U.S.C. 7001(c) only makes an electronic record satisfy a writing
// requirement for a consumer when the consumer was given the hardware and
// software requirements, told how to get a paper copy, told how to withdraw
// consent, and then affirmatively consented. v0 recorded a bare `consent:
// true` boolean with no text behind it, so there was nothing to show a court.
// v0.2 pins the exact text, versions it, and records which version the signer
// saw together with a digest of the text they were shown.
//
// Dependency-free (node builtins only) so the unit tests run under
// `node --test` with type stripping, same rule as lib/signing.ts.

// Bump on ANY wording change. The recorded consent stores the version and a
// digest of the text, so an old consent stays interpretable after a rewrite.
export const DISCLOSURE_VERSION = "2026-09-05.1";

// Which body of text a signer is shown. `w9` adds the IRS certification a
// Form W-9 signature carries; every signer, W-9 or not, gets the consumer
// consent sections.
export const DISCLOSURE_KINDS = ["individual", "w9"] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

export type DisclosureSection = { heading: string; body: string };

export type Disclosure = {
  version: string;
  kind: DisclosureKind;
  title: string;
  sections: DisclosureSection[];
  acknowledgement: string;
};

const CONTACT = "sign@redbtn.io";

// Shared consumer sections. Wording is deliberately plain and specific: the
// requirements section names the real requirements of this signing page
// rather than a generic browser list.
const INDIVIDUAL_SECTIONS: DisclosureSection[] = [
  {
    heading: "Scope of your consent",
    body:
      "You are agreeing to sign this document electronically and to receive it, and the records " +
      "of your signature, in electronic form. Your consent applies to this envelope only. It is " +
      "not a standing consent for future documents.",
  },
  {
    heading: "Hardware and software you need",
    body:
      "To view and sign this document you need a device with an up to date web browser that " +
      "supports JavaScript and HTML5 canvas (current versions of Chrome, Safari, Edge or Firefox), " +
      "a connection to the internet, the ability to display and read PDF files, and enough storage " +
      "or a printer if you want to keep your own copy. If these requirements change in a way that " +
      "affects your ability to access records, you will be told and given the chance to withdraw " +
      "your consent.",
  },
  {
    heading: "Getting a paper copy",
    body:
      "You may download and print this document from this page before you sign it, and the sender " +
      "sends you the executed copy once every signer has finished. You may also request a paper " +
      "copy at no charge by writing to " +
      CONTACT +
      " with the name of the document and the address to send it to.",
  },
  {
    heading: "Withdrawing your consent",
    body:
      "You may withdraw your consent to sign electronically at any time before you complete " +
      "signing, by closing this page and telling the sender, or by writing to " +
      CONTACT +
      ". Withdrawing consent means this document is not signed by you electronically. It does not " +
      "undo a signature you already completed, and the sender may then ask you to sign on paper. " +
      "There is no charge to withdraw.",
  },
  {
    heading: "Keeping your contact details current",
    body:
      "If the email address or phone number the sender holds for you changes, tell the sender " +
      "directly. redSign does not send signing links itself in this version, so a stale address " +
      "reaches the sender, not us.",
  },
  {
    heading: "What is recorded",
    body:
      "When you consent and when you sign, redSign records the date and time from its own clock, " +
      "your IP address as reported by the network in front of it, your browser's user agent " +
      "string, and the version of this disclosure. That record is printed on the certificate page " +
      "appended to the executed document and is available to the sender through the audit trail.",
  },
];

// Form W-9, Part II. The perjury certification is the operative statement the
// IRS requires a W-9 signature to carry; showing it at consent time is what
// makes the electronic signature acceptable under the IRS electronic W-9 rules
// (Publication 1167 / the Form W-9 instructions).
const W9_CERTIFICATION: DisclosureSection = {
  heading: "Certification under penalties of perjury",
  body:
    "By signing this Form W-9 electronically you certify, under penalties of perjury, that: " +
    "(1) the taxpayer identification number shown on this form is your correct taxpayer " +
    "identification number, or you are waiting for a number to be issued to you; (2) you are not " +
    "subject to backup withholding because you are exempt from backup withholding, or you have " +
    "not been notified by the Internal Revenue Service that you are subject to backup withholding " +
    "as a result of a failure to report all interest or dividends, or the IRS has notified you " +
    "that you are no longer subject to backup withholding; (3) you are a U.S. citizen or other " +
    "U.S. person; and (4) the FATCA code entered on this form, if any, indicating that you are " +
    "exempt from FATCA reporting is correct. You further certify that you are the person whose " +
    "name appears on this form and that you intend your electronic signature to be your " +
    "signature on it.",
};

const ACK_INDIVIDUAL =
  "I have read the disclosure above. I consent to sign this document electronically and I agree " +
  "that my electronic signature is legally binding.";

const ACK_W9 =
  "I have read the disclosure above, including the certification under penalties of perjury. I " +
  "consent to sign this Form W-9 electronically and I agree that my electronic signature is " +
  "legally binding.";

// Envelope metadata carries {app, orgId, kind, instanceId}. `kind` is the
// consumer's own document classification (redFinance sends "w9" and
// "agreement"); anything that is not a W-9 gets the individual disclosure.
export function disclosureKindFor(metadata: unknown): DisclosureKind {
  const kind =
    metadata && typeof metadata === "object"
      ? String((metadata as Record<string, unknown>).kind ?? "").toLowerCase()
      : "";
  return kind === "w9" || kind === "w-9" ? "w9" : "individual";
}

export function disclosureFor(kind: DisclosureKind): Disclosure {
  const w9 = kind === "w9";
  return {
    version: DISCLOSURE_VERSION,
    kind,
    title: w9
      ? "Electronic signature and Form W-9 certification"
      : "Consent to sign electronically",
    sections: w9 ? [W9_CERTIFICATION, ...INDIVIDUAL_SECTIONS] : INDIVIDUAL_SECTIONS,
    acknowledgement: w9 ? ACK_W9 : ACK_INDIVIDUAL,
  };
}

// Canonical flattening: what gets digested. Stable across key order because it
// is built from the array, not from JSON.stringify of an object.
export function disclosureText(d: Disclosure): string {
  return [
    `${d.title} (version ${d.version})`,
    ...d.sections.map((s) => `${s.heading}\n${s.body}`),
    d.acknowledgement,
  ].join("\n\n");
}

// Recorded alongside the consent so "which words did this person actually
// agree to" is answerable even if the version string is later reused by
// mistake.
export function disclosureSha256(d: Disclosure): string {
  return crypto.createHash("sha256").update(disclosureText(d), "utf8").digest("hex");
}
