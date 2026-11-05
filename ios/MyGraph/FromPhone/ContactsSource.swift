import Foundation
import Contacts

/// Contacts: the cards in the iPhone's Contacts, sent as `contactsPayload`. Labels ("mother", "work") are written the
/// way the iPhone shows them, in its language. The card's note is not read: Apple keeps notes behind a separate
/// entitlement that this app doesn't ask for.
enum ContactsSource {
    static var status: CNAuthorizationStatus { CNContactStore.authorizationStatus(for: .contacts) }

    /// Full or limited access (iOS 18 lets a person share only some contacts).
    static var canRead: Bool {
        switch status {
        case .authorized, .limited: return true
        default: return false
        }
    }

    static func requestAccess() async -> Bool {
        (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
    }

    static var keys: [CNKeyDescriptor] {
        [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)] + ([
            CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
            CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactBirthdayKey, CNContactPostalAddressesKey,
            CNContactOrganizationNameKey, CNContactJobTitleKey, CNContactRelationsKey,
        ] as [CNKeyDescriptor])
    }

    /// Every readable card, mapped. Runs off the main thread (enumerating can take a moment on a big address book).
    static func readAll() async throws -> [ContactItem] {
        try await Task.detached(priority: .userInitiated) {
            let store = CNContactStore()
            let req = CNContactFetchRequest(keysToFetch: keys)
            req.unifyResults = true
            var out: [ContactItem] = []
            try store.enumerateContacts(with: req) { c, _ in
                if let item = item(from: c) { out.append(item) }
            }
            return out
        }.value
    }

    // MARK: Mapping (pure, unit-tested)

    static func label(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return PhoneImportKit.clip(CNLabeledValue<NSString>.localizedString(forLabel: raw), 60)
    }

    /// One card as the schema wants it; nil for a card with no name at all.
    static func item(from c: CNContact) -> ContactItem? {
        let given = c.isKeyAvailable(CNContactGivenNameKey) ? c.givenName : ""
        let family = c.isKeyAvailable(CNContactFamilyNameKey) ? c.familyName : ""
        let org = c.isKeyAvailable(CNContactOrganizationNameKey) ? c.organizationName : ""
        let formatted = CNContactFormatter.string(from: c, style: .fullName)
        let joined = [given, family].filter { !$0.isEmpty }.joined(separator: " ")
        guard let name = PhoneImportKit.clip(formatted, 200) ?? PhoneImportKit.clip(joined, 200) ?? PhoneImportKit.clip(org, 200) else { return nil }

        var item = ContactItem(id: PhoneImportKit.clip(c.identifier, 200) ?? UUID().uuidString, name: name)
        item.givenName = PhoneImportKit.clip(given, 100)
        item.familyName = PhoneImportKit.clip(family, 100)
        if c.isKeyAvailable(CNContactNicknameKey) { item.nickname = PhoneImportKit.clip(c.nickname, 100) }
        if c.isKeyAvailable(CNContactEmailAddressesKey) {
            item.emails = Array(c.emailAddresses.compactMap { lv in
                PhoneImportKit.clip(lv.value as String, 320).map { ImportLabelled(label: label(lv.label), value: $0) }
            }.prefix(20))
        }
        if c.isKeyAvailable(CNContactPhoneNumbersKey) {
            item.phones = Array(c.phoneNumbers.compactMap { lv in
                PhoneImportKit.clip(lv.value.stringValue, 320).map { ImportLabelled(label: label(lv.label), value: $0) }
            }.prefix(20))
        }
        if c.isKeyAvailable(CNContactBirthdayKey) { item.birthday = PhoneImportKit.birthday(c.birthday) }
        if c.isKeyAvailable(CNContactPostalAddressesKey) {
            item.addresses = Array(c.postalAddresses.compactMap { lv -> ContactAddress? in
                let a = lv.value
                let out = ContactAddress(label: label(lv.label), street: PhoneImportKit.clip(a.street, 200), city: PhoneImportKit.clip(a.city, 100),
                                         postalCode: PhoneImportKit.clip(a.postalCode, 20),
                                         country: PhoneImportKit.clip(a.country, 100) ?? PhoneImportKit.clip(a.isoCountryCode.uppercased(), 100))
                return out.street == nil && out.city == nil && out.postalCode == nil && out.country == nil ? nil : out
            }.prefix(10))
        }
        item.organization = PhoneImportKit.clip(org, 200)
        if c.isKeyAvailable(CNContactJobTitleKey) { item.jobTitle = PhoneImportKit.clip(c.jobTitle, 200) }
        if c.isKeyAvailable(CNContactRelationsKey) {
            item.related = Array(c.contactRelations.compactMap { lv -> ContactRelated? in
                guard let n = PhoneImportKit.clip(lv.value.name, 200) else { return nil }
                return ContactRelated(label: label(lv.label) ?? String(localized: "related"), name: n)
            }.prefix(20))
        }
        return item
    }
}
