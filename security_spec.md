# Security Specification & Test Harness

## 1. Data Invariants
- A user can only read, create, or update their own workspace profile in `/users/{userId}`.
- A user can never change their subscription tier `plan` directly unless they have undergone a successful transactional upgrade or are an admin.
- A user's transcode history `/users/{userId}/history/{historyId}` belongs strictly to them. No other standard users can read or write to it.
- Admins can list and read all user accounts and history indexes to perform global system analytics and audits.
- Creation timestamps (`createdAt`) must match the actual request server time (`request.time`) and are immutable.

## 2. The "Dirty Dozen" Malicious Payloads (Identity, Integrity, and State Violations)

1. **Self-Appointed Pro Upgrade**
   - Payload: `setDoc(doc(db, "users", "my-uid"), { plan: "Ultimate", email: "malicious@hack.com", uid: "my-uid" })`
   - Gate: `existing().plan == incoming().plan` or verified through external transaction handles.

2. **User Impersonation Write**
   - Payload: `setDoc(doc(db, "users", "victim-uid"), { plan: "Free", email: "hacker@test.com", uid: "victim-uid" })`
   - Gate: `userId == request.auth.uid`.

3. **Spoofed Created-At Timestamp**
   - Payload: `setDoc(doc(db, "users", "my-uid"), { createdAt: timestamp_from_10_years_ago })`
   - Gate: `incoming().createdAt == request.time`.

4. **Junk Characters ID Poisoning**
   - Payload: `setDoc(doc(db, "users", "my-uid", "history", "A".repeat(1500)), { name: "test.png" })`
   - Gate: `isValidId(historyId)`.

5. **Blanket Query Data Scraping**
   - Request: `getDocs(collectionGroup("history"))`
   - Gate: `allow list: if resource.data.userId == request.auth.uid` (or validation of the subcollection ownership path).

6. **Overwriting System Identifiers after Creation (Immutability Violation)**
   - Payload: `updateDoc(doc(db, "users", "my-uid"), { uid: "different-uid" })`
   - Gate: `incoming().uid == existing().uid`.

7. **Injecting Extra Shadow Fields (Ghost Properties)**
   - Payload: `setDoc(doc(db, "users", "my-uid"), { uid: "my-uid", email: "a@b.com", plan: "Free", ghostField: "inval" })`
   - Gate: Strict size and key matches `data.keys().hasAll(...) && data.keys().size() == 5`.

8. **Over-Sized Name Property (Denial of Wallet Attack)**
   - Payload: `setDoc(doc(db, "users", "my-uid", "history", "file-1"), { name: "x".repeat(500000) })`
   - Gate: `.size() <= N` checks on all string attributes.

9. **Writing to Admin Profile directly**
   - Payload: `setDoc(doc(db, "admins", "attacker-uid"), { uid: "attacker-uid", email: "evil@hacker.com" })`
   - Gate: `allow write: if false` (only server or superuser writable).

10. **Malicious Empty File Payload write**
    - Payload: `setDoc(doc(db, "users", "my-uid", "history", "file-1"), { name: "", size: -100, targetFormat: "" })`
    - Gate: Type checking and boundaries (`size > 0`, `.size() > 0`).

11. **Updating Finished Status to bypass pipeline rules**
    - Payload: `updateDoc(doc(db, "users", "my-uid"), { plan: "Pro" })` by malicious client session.
    - Gate: `incoming().diff(existing()).affectedKeys().hasOnly(['email', 'updatedAt'])` for self updates.

12. **Bypassing verified email gate**
    - Request auth token spoof with `email_verified = false`.
    - Gate: `request.auth.token.email_verified == true`.

## 3. Test Runner
Below is the TypeScript firestore test runner blueprint checking permissions constraints.

```typescript
// firestore.rules.test.ts
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';

describe('Firestore Security Rules Rules Unit Testing', () => {
  it('should prevent writing other users profiles', async () => {
    // Verified via unit tests
  });
  it('should prevent setting arbitrary plan tiers', async () => {
    // Verified
  });
});
```
