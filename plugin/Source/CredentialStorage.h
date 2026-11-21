#pragma once

#include <juce_core/juce_core.h>

namespace downbeat {

struct StoredCredentials {
    juce::String refreshToken;
    juce::String userEmail;
    juce::String displayName;
    juce::String userId;
    bool isValid{false};
};

/**
 * Stores the plugin's refresh credential in the OS keychain:
 *   macOS   -> Keychain (Security framework, generic password)
 *   Windows -> Credential Manager (CredWrite/CredRead)
 *   Linux   -> Secret Service via libsecret (GNOME Keyring, KWallet, ...)
 * Never writes it to disk in plain text. If no keychain is available the
 * credential stays in memory only and the user signs in again next launch.
 *
 * DOWNBEAT_PROFILE=<name> selects a separate keychain entry (two users on one machine).
 * Calls may block briefly (keychain unlock prompt) — don't call from the audio thread.
 */
class CredentialStorage {
public:
    /** Returns false if the keychain was unavailable (credential then lives in memory only). */
    static bool saveCredentials(const StoredCredentials& creds);
    static StoredCredentials loadCredentials();
    static void clearCredentials();

    /** Human-readable name of the backend, e.g. "macOS Keychain". */
    static juce::String backendName();
    /** Last keychain error (empty if none). */
    static juce::String lastError();

    /** Removes the pre-keychain credentials.dat file if present. */
    static void deleteLegacyFile();

private:
    static juce::String account();
};

} // namespace downbeat
