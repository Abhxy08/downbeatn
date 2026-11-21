// Manual check that the OS keychain round-trips a credential (needs a desktop session / secret service).
#include "CredentialStorage.h"
#include <iostream>

int main() {
    using namespace downbeat;
    std::cout << "Backend: " << CredentialStorage::backendName() << "\n";
    StoredCredentials c;
    c.refreshToken = "test-refresh-" + juce::Uuid().toString();
    c.userEmail = "keychain-check@downbeat.dev";
    c.displayName = "Keychain Check";
    c.userId = "uid-check";
    if (!CredentialStorage::saveCredentials(c)) {
        std::cout << "SAVE FAILED: " << CredentialStorage::lastError() << "\n";
        return 1;
    }
    const auto back = CredentialStorage::loadCredentials();
    const bool ok = back.isValid && back.refreshToken == c.refreshToken && back.displayName == c.displayName;
    std::cout << "Round-trip: " << (ok ? "OK" : "MISMATCH") << "\n";
    CredentialStorage::clearCredentials();
    const bool gone = !CredentialStorage::loadCredentials().isValid;
    std::cout << "Cleared: " << (gone ? "OK" : "STILL PRESENT") << "\n";
    return ok && gone ? 0 : 1;
}
