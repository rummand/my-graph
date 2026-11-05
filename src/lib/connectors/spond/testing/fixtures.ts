/**
 * Spond answers for tests, in the shape the open-source clients see from api.spond.com/core/v1 (written by hand: no
 * real data). Parent "Mette Holm" (profile P-MOM) is guardian of Ida (two groups, two member ids) and Karl (one group).
 */
export const PROFILE = { id: "P-MOM", firstName: "Mette", lastName: "Holm", primaryEmail: "mette@example.com" };

export const GROUPS = [
  {
    id: "G-FOOT", name: "B93 U10 piger", activity: "football",
    subGroups: [{ id: "S1", name: "Hold 1" }],
    members: [
      { id: "M-IDA-1", firstName: "Ida", lastName: "Holm", dateOfBirth: "2016-04-02", guardians: [{ id: "GD1", firstName: "Mette", lastName: "Holm", profile: { id: "P-MOM" } }], subGroups: ["S1"] },
      { id: "M-OTHER", firstName: "Sofie", lastName: "Berg", guardians: [{ id: "GD2", firstName: "Anne", lastName: "Berg", profile: { id: "P-ANNE" } }] },
      { id: "M-COACH", firstName: "Lars", lastName: "Træner", profile: { id: "P-COACH" } },
    ],
  },
  {
    id: "G-SWIM", name: "Svømmeklubben Delfinen", activity: "swimming",
    members: [
      { id: "M-IDA-2", firstName: "Ida", lastName: "Holm", dateOfBirth: "2016-04-02", guardians: [{ id: "GD3", profile: { id: "P-MOM" } }] },
      { id: "M-KARL", firstName: "Karl", lastName: "Holm", guardians: [{ id: "GD4", profile: { id: "P-MOM" } }] },
    ],
  },
  { id: "G-NONE", name: "Forældregruppe", members: [{ id: "M-X", firstName: "Hans", lastName: "Hansen", profile: { id: "P-HANS" } }] },
];

export const EVENTS = [
  {
    id: "E-TRAIN", heading: "Træning", description: "Husk drikkedunk.\n\nVi træner på kunstgræs.",
    startTimestamp: "2026-11-10T16:00:00Z", endTimestamp: "2026-11-10T17:15:00Z", meetupPrior: 15, cancelled: false, matchEvent: false,
    location: { id: "L1", feature: "Kunstgræsbanen", address: "Peter Bangs Vej 147, 2000 Frederiksberg", latitude: 55.68, longitude: 12.5 },
    recipients: { group: { id: "G-FOOT", name: "B93 U10 piger" } },
    responses: { acceptedIds: ["M-OTHER"], declinedIds: [], unansweredIds: ["M-IDA-1"], waitinglistIds: [], unconfirmedIds: [] },
    rsvpDate: "2026-11-09T18:00:00Z", updated: 1762300000000,
  },
  {
    id: "E-MATCH", heading: "Kamp mod KB", startTimestamp: "2026-11-15T09:00:00Z", endTimestamp: "2026-11-15T10:30:00Z",
    meetupTimestamp: "2026-11-15T08:30:00Z", matchEvent: true, matchInfo: { type: "AWAY", teamName: "B93", opponentName: "KB U10" },
    location: { feature: "KB's anlæg", address: "Pile Allé 14, 2000 Frederiksberg" },
    recipients: { group: { id: "G-FOOT" } },
    responses: { acceptedIds: ["M-IDA-1"], declinedIds: [], unansweredIds: [], waitinglistIds: [], unconfirmedIds: [] },
  },
  {
    id: "E-SWIM", heading: "Stævne i Bellahøj", startTimestamp: "2026-11-22T08:00:00Z", endTimestamp: "2026-11-22T14:00:00Z",
    location: { feature: "Bellahøj Svømmestadion" }, recipients: { group: { id: "G-SWIM" } },
    responses: { acceptedIds: [], declinedIds: ["M-KARL"], unansweredIds: [], waitinglistIds: [], unconfirmedIds: ["M-IDA-2"] },
  },
  { id: "E-CANCEL", heading: "Træning", startTimestamp: "2026-11-12T16:00:00Z", cancelled: true, recipients: { group: { id: "G-FOOT" } }, responses: {} },
  // Someone else's group: left out.
  { id: "E-PARENTS", heading: "Forældremøde", startTimestamp: "2026-11-20T18:00:00Z", recipients: { group: { id: "G-NONE" } }, responses: { unansweredIds: ["M-X"] } },
  // Broken: no start.
  { id: "E-BROKEN", heading: "Nothing" },
];
