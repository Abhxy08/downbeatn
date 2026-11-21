#if defined(_WIN32)
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
 #include <wincred.h>
 #if defined(_MSC_VER)
  #pragma comment(lib, "Advapi32.lib")
 #endif
#elif defined(__APPLE__)
 #include <Security/Security.h>
#elif defined(DOWNBEAT_HAS_LIBSECRET)
 #include <libsecret/secret.h>
#endif

#include "CredentialStorage.h"

namespace downbeat {

namespace {
juce::CriticalSection errorLock;
juce::String lastErr;

void setError(const juce::String& e) {
    const juce::ScopedLock sl(errorLock);
    lastErr = e;
}

const char* kService = "com.downbeat.plugin";

// ---------------------------------------------------------------------------
// Platform backends: store / load / remove one UTF-8 secret per account
// ---------------------------------------------------------------------------
#if defined(_WIN32)

std::wstring target(const juce::String& acct) { return (juce::String("DownBeat/") + acct).toWideCharPointer(); }

bool storeSecret(const juce::String& acct, const juce::String& secret) {
    const auto t = target(acct);
    const auto bytes = secret.toStdString();
    CREDENTIALW c{};
    c.Type = CRED_TYPE_GENERIC;
    c.TargetName = const_cast<LPWSTR>(t.c_str());
    c.CredentialBlobSize = (DWORD) bytes.size();
    c.CredentialBlob = (LPBYTE) bytes.data();
    c.Persist = CRED_PERSIST_LOCAL_MACHINE;
    c.UserName = const_cast<LPWSTR>(L"DownBeat");
    if (!CredWriteW(&c, 0)) {
        setError("CredWrite failed (" + juce::String((int) GetLastError()) + ")");
        return false;
    }
    return true;
}

bool loadSecret(const juce::String& acct, juce::String& out) {
    PCREDENTIALW c = nullptr;
    if (!CredReadW(target(acct).c_str(), CRED_TYPE_GENERIC, 0, &c)) return false;
    out = juce::String::fromUTF8((const char*) c->CredentialBlob, (int) c->CredentialBlobSize);
    CredFree(c);
    return true;
}

void removeSecret(const juce::String& acct) { CredDeleteW(target(acct).c_str(), CRED_TYPE_GENERIC, 0); }

juce::String backend() { return "Windows Credential Manager"; }

#elif defined(__APPLE__)

struct CF {
    CFTypeRef ref;
    explicit CF(CFTypeRef r) : ref(r) {}
    ~CF() { if (ref) CFRelease(ref); }
};

CFMutableDictionaryRef baseQuery(const juce::String& acct, CF& svc, CF& acc) {
    auto q = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    svc.ref = CFStringCreateWithCString(nullptr, kService, kCFStringEncodingUTF8);
    acc.ref = CFStringCreateWithCString(nullptr, acct.toRawUTF8(), kCFStringEncodingUTF8);
    CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(q, kSecAttrService, svc.ref);
    CFDictionarySetValue(q, kSecAttrAccount, acc.ref);
    return q;
}

bool storeSecret(const juce::String& acct, const juce::String& secret) {
    CF svc(nullptr), acc(nullptr);
    CF q(baseQuery(acct, svc, acc));
    SecItemDelete((CFDictionaryRef) q.ref);
    CF data(CFDataCreate(nullptr, (const UInt8*) secret.toRawUTF8(), (CFIndex) secret.getNumBytesAsUTF8()));
    CFDictionarySetValue((CFMutableDictionaryRef) q.ref, kSecValueData, data.ref);
    CFDictionarySetValue((CFMutableDictionaryRef) q.ref, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
    const OSStatus st = SecItemAdd((CFDictionaryRef) q.ref, nullptr);
    if (st != errSecSuccess) {
        setError("Keychain SecItemAdd failed (" + juce::String((int) st) + ")");
        return false;
    }
    return true;
}

bool loadSecret(const juce::String& acct, juce::String& out) {
    CF svc(nullptr), acc(nullptr);
    CF q(baseQuery(acct, svc, acc));
    CFDictionarySetValue((CFMutableDictionaryRef) q.ref, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue((CFMutableDictionaryRef) q.ref, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = nullptr;
    if (SecItemCopyMatching((CFDictionaryRef) q.ref, &result) != errSecSuccess || result == nullptr) return false;
    CF data(result);
    out = juce::String::fromUTF8((const char*) CFDataGetBytePtr((CFDataRef) data.ref), (int) CFDataGetLength((CFDataRef) data.ref));
    return true;
}

void removeSecret(const juce::String& acct) {
    CF svc(nullptr), acc(nullptr);
    CF q(baseQuery(acct, svc, acc));
    SecItemDelete((CFDictionaryRef) q.ref);
}

juce::String backend() { return "macOS Keychain"; }

#elif defined(DOWNBEAT_HAS_LIBSECRET)

const SecretSchema* schema() {
    static const SecretSchema s = {
        "com.downbeat.plugin.Credentials",
        SECRET_SCHEMA_NONE,
        { { "account", SECRET_SCHEMA_ATTRIBUTE_STRING }, { nullptr, (SecretSchemaAttributeType) 0 } },
        0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    };
    return &s;
}

bool storeSecret(const juce::String& acct, const juce::String& secret) {
    GError* err = nullptr;
    const gboolean ok = secret_password_store_sync(schema(), SECRET_COLLECTION_DEFAULT, "DownBeat plugin sign-in",
                                                   secret.toRawUTF8(), nullptr, &err, "account", acct.toRawUTF8(), nullptr);
    if (!ok || err != nullptr) {
        setError("Secret Service: " + juce::String(err != nullptr ? err->message : "store failed"));
        if (err != nullptr) g_error_free(err);
        return false;
    }
    return true;
}

bool loadSecret(const juce::String& acct, juce::String& out) {
    GError* err = nullptr;
    gchar* pw = secret_password_lookup_sync(schema(), nullptr, &err, "account", acct.toRawUTF8(), nullptr);
    if (err != nullptr) {
        setError("Secret Service: " + juce::String(err->message));
        g_error_free(err);
    }
    if (pw == nullptr) return false;
    out = juce::String::fromUTF8(pw);
    secret_password_free(pw);
    return true;
}

void removeSecret(const juce::String& acct) {
    GError* err = nullptr;
    secret_password_clear_sync(schema(), nullptr, &err, "account", acct.toRawUTF8(), nullptr);
    if (err != nullptr) g_error_free(err);
}

juce::String backend() { return "Secret Service (libsecret)"; }

#else

// No keychain on this platform/build: keep the credential in memory only.
bool storeSecret(const juce::String&, const juce::String&) {
    setError("No OS keychain available in this build");
    return false;
}
bool loadSecret(const juce::String&, juce::String&) { return false; }
void removeSecret(const juce::String&) {}
juce::String backend() { return "memory only (no keychain)"; }

#endif
} // namespace

// ---------------------------------------------------------------------------
juce::String CredentialStorage::account() {
    const auto profile = juce::SystemStats::getEnvironmentVariable("DOWNBEAT_PROFILE", {})
                             .retainCharacters("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_");
    return profile.isNotEmpty() ? profile : juce::String("default");
}

bool CredentialStorage::saveCredentials(const StoredCredentials& creds) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("refreshToken", creds.refreshToken);
    obj->setProperty("userEmail", creds.userEmail);
    obj->setProperty("displayName", creds.displayName);
    obj->setProperty("userId", creds.userId);
    setError({});
    return storeSecret(account(), juce::JSON::toString(juce::var(obj), true));
}

StoredCredentials CredentialStorage::loadCredentials() {
    StoredCredentials creds;
    juce::String json;
    if (!loadSecret(account(), json)) return creds;
    const auto parsed = juce::JSON::parse(json);
    if (parsed.isObject() && parsed["refreshToken"].isString()) {
        creds.refreshToken = parsed["refreshToken"].toString();
        creds.userEmail = parsed["userEmail"].toString();
        creds.displayName = parsed["displayName"].toString();
        creds.userId = parsed["userId"].toString();
        creds.isValid = creds.refreshToken.isNotEmpty();
    }
    return creds;
}

void CredentialStorage::clearCredentials() {
    removeSecret(account());
}

juce::String CredentialStorage::backendName() { return backend(); }

juce::String CredentialStorage::lastError() {
    const juce::ScopedLock sl(errorLock);
    return lastErr;
}

void CredentialStorage::deleteLegacyFile() {
    // Before Phase 7 the token was kept in an XOR-obfuscated file; those tokens are no longer valid.
    auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("DownBeat");
    dir.getChildFile("credentials.dat").deleteFile();
    auto profiles = dir.getChildFile("profiles");
    if (profiles.isDirectory())
        for (auto& f : profiles.findChildFiles(juce::File::findFiles, true, "credentials.dat")) f.deleteFile();
}

} // namespace downbeat
