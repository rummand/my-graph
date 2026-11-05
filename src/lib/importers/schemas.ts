/**
 * The JSON shapes the iPhone app and the Mac helper send to POST /api/import/<importer> as `data` (pure). Fixed
 * contracts: the server's importers and the native code are built against them. Additive changes only (new optional
 * fields); anything else needs a new importer id.
 */
import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const text = (max: number) => z.string().max(max);
const labelled = z.object({ label: text(60).optional(), value: text(320) });

/** contacts: the iPhone's Contacts (CNContactStore), or any address book turned into this shape. */
export const contactsPayload = z.object({
  contacts: z.array(z.object({
    /** The id at the source (CNContact.identifier), so a later batch updates instead of duplicating. */
    id: text(200),
    name: text(200),
    givenName: text(100).optional(),
    familyName: text(100).optional(),
    nickname: text(100).optional(),
    emails: z.array(labelled).max(20).default([]),
    phones: z.array(labelled).max(20).default([]),
    /** "YYYY-MM-DD", or "--MM-DD" when the year isn't known. */
    birthday: z.string().regex(/^(\d{4}-|--)\d{2}-\d{2}$/).optional(),
    addresses: z.array(z.object({
      label: text(60).optional(), street: text(200).optional(), city: text(100).optional(), postalCode: text(20).optional(), country: text(100).optional(),
    })).max(10).default([]),
    organization: text(200).optional(),
    jobTitle: text(200).optional(),
    /** Related names ("mother": "Ida Hansen"), from the card. */
    related: z.array(z.object({ label: text(60), name: text(200) })).max(20).default([]),
    note: text(4000).optional(),
  })).max(20_000),
});
export type ContactsPayload = z.infer<typeof contactsPayload>;

/** photos: metadata of photos on the iPhone (PhotoKit). The image itself, when sent, is a library upload (`sourceId`). */
export const photosPayload = z.object({
  photos: z.array(z.object({
    /** PHAsset.localIdentifier. */
    id: text(200),
    takenAt: iso.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    /** A place name the phone already knows (reverse-geocoded on the device), if any. */
    placeName: text(200).optional(),
    albums: z.array(text(200)).max(50).default([]),
    favorite: z.boolean().optional(),
    /** The library source holding the image, when the app uploaded it too. */
    sourceId: z.string().uuid().optional(),
  })).max(20_000),
});
export type PhotosPayload = z.infer<typeof photosPayload>;

/** places: visits the iPhone noticed (CLVisit), opt-in. */
export const placesPayload = z.object({
  visits: z.array(z.object({
    arrival: iso,
    departure: iso.optional(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000).optional(),
    placeName: text(200).optional(),
  })).max(50_000),
});
export type PlacesPayload = z.infer<typeof placesPayload>;

/** health: what the person chose to share from Apple Health. Always sensitive and private. */
export const healthPayload = z.object({
  records: z.array(z.object({
    id: text(200),
    type: z.enum(["vaccination", "condition", "medication", "allergy", "lab", "measurement", "procedure", "visit"]),
    name: text(300),
    at: iso.optional(),
    value: z.number().optional(),
    unit: text(40).optional(),
    note: text(2000).optional(),
  })).max(20_000),
});
export type HealthPayload = z.infer<typeof healthPayload>;

/** imessage: conversations read by the Mac helper from Messages (chat.db), newest batch since its cursor. */
export const imessagePayload = z.object({
  chats: z.array(z.object({
    id: text(300),
    name: text(300).optional(),
    participants: z.array(z.object({ handle: text(320), name: text(200).optional() })).max(200),
    messages: z.array(z.object({
      id: text(300),
      at: iso,
      /** A participant's handle, or "me". */
      from: text(320),
      text: text(20_000),
      attachments: z.array(z.object({ filename: text(300), mime: text(100).optional() })).max(50).default([]),
    })).max(50_000),
  })).max(5_000),
});
export type IMessagePayload = z.infer<typeof imessagePayload>;

/** apple_notes: notes read by the Mac helper from Notes, as plain text. */
export const appleNotesPayload = z.object({
  notes: z.array(z.object({
    id: text(300),
    title: text(500),
    folder: text(300).optional(),
    createdAt: iso.optional(),
    updatedAt: iso.optional(),
    text: text(500_000),
  })).max(20_000),
});
export type AppleNotesPayload = z.infer<typeof appleNotesPayload>;
