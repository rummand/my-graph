/**
 * Holdsport answers for tests, in the documented shape of api.holdsport.dk/v1 (written by hand: no real data). The
 * login is the child's own (user 501, Ida Holm, ida@example.com).
 */
export const TEAMS = [
  { id: 11, name: "U10 piger", primary_color: "#c00", secondary_color: "#fff", role: 1 },
  { id: 12, name: "Håndbold U11", primary_color: "#00c", secondary_color: "#fff", role: 1 },
];

export const MEMBERS_11 = [
  { id: 501, firstname: "Ida", lastname: "Holm", role: 1, birthday: "2016-04-02", addresses: [{ street: "Vej 1", city: "Frederiksberg", postcode: "2000", email: "ida@example.com", mobile: "+45 12 34 56 78" }] },
  { id: 502, firstname: "Sofie", lastname: "Berg", role: 1, addresses: [{ email: "sofie@example.com" }] },
];

export const ACTIVITIES_11 = [
  {
    id: 9001, club: "Frederiksberg IF", name: "Træning", starttime: "2026-11-10T17:00:00+01:00", endtime: "2026-11-10T18:15:00+01:00",
    comment: "Husk benskinner", place: "Frederiksberg Idrætspark, bane 3", pickup_place: null, pickup_time: null, status: 1, event_type: "Træning",
    activities_users: [
      { id: 1, user_id: 501, name: "Ida Holm", status: "Ikke svaret", status_code: 0, updated_at: "2026-11-01T10:00:00+01:00" },
      { id: 2, user_id: 502, name: "Sofie Berg", status: "Tilmeldt", status_code: 1, updated_at: "2026-11-02T10:00:00+01:00" },
    ],
  },
  {
    id: 9002, club: "Frederiksberg IF", name: "Kamp: FIF - B93", starttime: "2026-11-14T10:00:00+01:00", endtime: "2026-11-14T11:30:00+01:00",
    place: "Frederiksberg Idrætspark", pickup_time: "2026-11-14T09:30:00+01:00", event_type: "Kamp",
    activities_users: [{ id: 3, user_id: 501, name: "Ida Holm", status: "Tilmeldt", status_code: 1 }],
  },
  { id: 9003, club: "Frederiksberg IF", name: "AFLYST: Træning", starttime: "2026-11-12T17:00:00+01:00", activities_users: [] },
];

export const ACTIVITIES_12 = [
  { id: 9101, name: "Stævne i Ballerup", starttime: "2026-11-21T09:00:00+01:00", endtime: "2026-11-21T15:00:00+01:00", event_type: "Turnering",
    activities_users: [{ id: 4, user_id: 501, name: "Ida Holm", status: "Afmeldt", status_code: 2 }] },
  // Far ahead: outside the window, the client stops.
  { id: 9199, name: "Juleafslutning", starttime: "2027-06-01T09:00:00+01:00" },
];
