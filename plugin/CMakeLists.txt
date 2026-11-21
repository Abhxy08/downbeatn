cmake_minimum_required(VERSION 3.22)
# macOS: one universal build that runs on Intel and Apple Silicon, macOS 11+
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
# CMake 4 refuses dependencies that declare cmake_minimum_required < 3.5
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "")
project(DownBeat VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 8 Integration via FetchContent or local JUCE_DIR
include(FetchContent)

if(DEFINED JUCE_DIR)
    message(STATUS "Using local JUCE from: ${JUCE_DIR}")
    add_subdirectory(${JUCE_DIR} JUCE)
else()
    message(STATUS "Fetching JUCE 8 (8.0.4) via FetchContent...")
    FetchContent_Declare(
        JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.4
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(JUCE)
endif()

# Plugin binaries are shared libraries, so static deps must be position-independent
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# WebSocket client (JUCE has none). TLS is needed for wss:// on Cloud Run:
#   macOS -> SecureTransport (system), Linux -> OpenSSL, Windows -> mbedTLS (fetched below,
#   certificates come from the Windows system store).
set(USE_TLS ON CACHE BOOL "" FORCE)
if(WIN32)
    set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
    set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
    set(GEN_FILES OFF CACHE BOOL "" FORCE)
    set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
    set(MBEDTLS_USER_CONFIG_FILE "${CMAKE_CURRENT_SOURCE_DIR}/mbedtls_user_config.h" CACHE FILEPATH "" FORCE)
    FetchContent_Declare(
        mbedtls
        GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
        GIT_TAG v3.6.2
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(mbedtls)
    # Hand IXWebSocket the fetched targets instead of letting it search the system
    set(MBEDTLS_FOUND TRUE)
    set(MBEDTLS_INCLUDE_DIRS "${mbedtls_SOURCE_DIR}/include")
    set(MBEDTLS_LIBRARIES mbedtls mbedx509 mbedcrypto)
endif()
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    ixwebsocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG v11.4.6
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(ixwebsocket)
if(WIN32)
    # IXWebSocket only enables its mbedTLS 3 code path when it finds mbedTLS itself
    target_compile_definitions(ixwebsocket PRIVATE IXWEBSOCKET_USE_MBED_TLS_MIN_VERSION_3)
endif()

# Ableton Link (tempo sync with Link-enabled DAWs on the local network).
# Header-only; SOURCE_SUBDIR points at a folder without CMakeLists so Link's own
# examples/tests aren't added to our build. License: GPL-2.0+ (see README).
FetchContent_Declare(
    link
    GIT_REPOSITORY https://github.com/Ableton/link.git
    GIT_TAG Link-4.1.1
    GIT_SHALLOW TRUE
    GIT_SUBMODULES "modules/asio-standalone"
    SOURCE_SUBDIR do-not-add
)
FetchContent_MakeAvailable(link)
include(${link_SOURCE_DIR}/AbletonLinkConfig.cmake)

# Determine plugin formats per platform
# AU is only valid on Apple macOS
set(DOWNBEAT_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND DOWNBEAT_FORMATS AU)
endif()

# Plugin Target Definition
juce_add_plugin(DownBeat
    COMPANY_NAME "DownBeat Audio"
    BUNDLE_ID com.downbeat.downbeat
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    PLUGIN_MANUFACTURER_CODE DbAu
    PLUGIN_CODE Dwbt
    FORMATS ${DOWNBEAT_FORMATS}
    PRODUCT_NAME "DownBeat"
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "DownBeat streams your microphone or instrument to your collaborators."
    PLIST_TO_MERGE "<plist><dict><key>NSLocalNetworkUsageDescription</key><string>DownBeat uses the local network for Ableton Link tempo sync and direct audio to collaborators.</string></dict></plist>"
)

target_sources(DownBeat PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/JitterBuffer.cpp
    Source/NetworkClient.cpp
    Source/SignalingClient.cpp
    Source/CredentialStorage.cpp
    Source/StandaloneSupport.cpp
    Source/AudioPacket.cpp
    Source/Stun.cpp
    Source/AudioTransport.cpp
    Source/LinkSync.cpp
)

target_include_directories(DownBeat PRIVATE
    Source
)

target_compile_definitions(DownBeat PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

# JUCE uses libcurl for HTTPS only on Linux (macOS/Windows use the system networking stack)
if(UNIX AND NOT APPLE)
    find_package(CURL REQUIRED)
    target_compile_definitions(DownBeat PRIVATE JUCE_USE_CURL=1)
    target_link_libraries(DownBeat PRIVATE CURL::libcurl)
else()
    target_compile_definitions(DownBeat PRIVATE JUCE_USE_CURL=0)
endif()

# OS keychain for the plugin's sign-in credential
if(APPLE)
    target_link_libraries(DownBeat PRIVATE "-framework Security" "-framework CoreFoundation")
elseif(WIN32)
    target_link_libraries(DownBeat PRIVATE advapi32)
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(LIBSECRET IMPORTED_TARGET libsecret-1)
    if(LIBSECRET_FOUND)
        target_link_libraries(DownBeat PRIVATE PkgConfig::LIBSECRET)
        target_compile_definitions(DownBeat PRIVATE DOWNBEAT_HAS_LIBSECRET=1)
    else()
        message(WARNING "libsecret-1 not found: the plugin will keep its sign-in in memory only (install libsecret dev package)")
    endif()
endif()

# Default backend URL baked into release builds (override at runtime with DOWNBEAT_SERVER_URL)
set(DOWNBEAT_DEFAULT_SERVER_URL "http://localhost:8088" CACHE STRING "Backend URL the plugin uses by default")
target_compile_definitions(DownBeat PRIVATE DOWNBEAT_DEFAULT_SERVER_URL="${DOWNBEAT_DEFAULT_SERVER_URL}")

target_link_libraries(DownBeat PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_audio_formats
    juce::juce_audio_devices
    juce::juce_audio_basics
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
    ixwebsocket
    Ableton::Link
)

# Unit Test Executable Target
add_executable(downbeat_tests
    Tests/JitterBufferTests.cpp
    Source/JitterBuffer.cpp
    Source/AudioPacket.cpp
    Source/Stun.cpp
)

target_include_directories(downbeat_tests PRIVATE
    Source
)

target_compile_definitions(downbeat_tests PRIVATE
    JUCE_USE_CURL=0
)

target_link_libraries(downbeat_tests PRIVATE
    juce::juce_audio_basics
    juce::juce_core
)

enable_testing()
add_test(NAME JitterBufferAndFifoTests COMMAND downbeat_tests)

# End-to-end UDP transport test (two transports on this machine; relay part needs the relay running)
add_executable(downbeat_transport_e2e
    Tests/TransportE2E.cpp
    Source/AudioTransport.cpp
    Source/JitterBuffer.cpp
    Source/AudioPacket.cpp
    Source/Stun.cpp
)
target_include_directories(downbeat_transport_e2e PRIVATE Source)
target_compile_definitions(downbeat_transport_e2e PRIVATE JUCE_USE_CURL=0)
target_link_libraries(downbeat_transport_e2e PRIVATE
    juce::juce_audio_basics
    juce::juce_core
    juce::juce_cryptography
)
add_test(NAME TransportE2E COMMAND downbeat_transport_e2e)

# Manual keychain round-trip check (not in ctest: needs a desktop keychain session)
add_executable(downbeat_keychain_check Tests/KeychainCheck.cpp Source/CredentialStorage.cpp)
target_include_directories(downbeat_keychain_check PRIVATE Source)
target_link_libraries(downbeat_keychain_check PRIVATE juce::juce_core)
target_compile_definitions(downbeat_keychain_check PRIVATE JUCE_USE_CURL=0)
if(APPLE)
    target_link_libraries(downbeat_keychain_check PRIVATE "-framework Security" "-framework CoreFoundation")
elseif(WIN32)
    target_link_libraries(downbeat_keychain_check PRIVATE advapi32)
elseif(LIBSECRET_FOUND)
    target_link_libraries(downbeat_keychain_check PRIVATE PkgConfig::LIBSECRET)
    target_compile_definitions(downbeat_keychain_check PRIVATE DOWNBEAT_HAS_LIBSECRET=1)
endif()
