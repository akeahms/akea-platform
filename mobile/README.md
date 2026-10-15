# Akea mobile app (iOS & Android)

An Expo app for hotel staff and managers. It uses the same Supabase project and permissions as the web portal, so people sign in with their portal account and see only what their role allows.

| Tab | Who sees what |
| --- | --- |
| **Today** | Clock in and clock out, this week's hours, next shift. Anyone with Dashboards access also sees last night's occupancy, ADR, RevPAR and revenue for each hotel. |
| **Schedule** | My published shifts for the next 2 weeks. Managers (Workforce edit) also see who is working today. |
| **Approvals** | Bills (Finance approve), purchase orders (Purchasing approve) and completed punches from the last 2 weeks (Workforce approve). |
| **Alerts** | Renewals for permits, insurance and documents, plus overdue bills. Tap an alert to open it in the portal. |
| **Account** | Role, company, a link to the full web portal, and sign out. |

Roles that require two-step sign-in must verify their authenticator code on the phone. The authenticator itself is set up in the web portal.

## Run it on your phone (about 5 minutes)

1. Install Node 20+ and the **Expo Go** app on your phone.
2. In this folder, run `npm run setup`. This installs packages that match Expo SDK 57.
3. Run `npx expo start`, then scan the QR code with your camera (iPhone) or with Expo Go (Android).

The Supabase URL and public key are in `app.json → extra`. You can override them with `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`.

## Build installable apps

```bash
npm i -g eas-cli
eas login
eas build --profile preview --platform android   # .apk to share directly
eas build --profile production --platform all    # store builds
eas submit --platform ios                        # TestFlight / App Store
eas submit --platform android                    # Google Play
```

Store publishing requires an Apple Developer account ($99/year) and a Google Play developer account ($25 one-time). The bundle ID and package name are both `com.akeahms.portal`.

## White label

Each company's name and accent colour come from its tenant record. The app icon and name in `app.json` apply to every company. For a fully branded app per client, copy `app.json`, change `name`, `slug`, the icons and the bundle ID, then build again.
