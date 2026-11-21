#include "SignalingClient.h"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

namespace downbeat {

namespace {
juce::var makeObject(std::initializer_list<std::pair<const char*, juce::var>> props) {
    auto* obj = new juce::DynamicObject();
    for (auto& [k, v] : props) obj->setProperty(k, v);
    return juce::var(obj);
}
} // namespace

SignalingClient::SignalingClient(TokenProvider provider)
    : tokenProvider(std::move(provider))
{
    ix::initNetSystem(); // required on Windows, no-op elsewhere
}

SignalingClient::~SignalingClient() {
    disconnect();
}

void SignalingClient::connect(const juce::String& wsUrl, const juce::String& sessionId, const juce::String& daw) {
    disconnect();

    {
        const juce::ScopedLock sl(lock);
        snapshot = {};
        snapshot.sessionId = sessionId;
        snapshot.status = SignalingStatus::Connecting;
        dawName = daw;
    }

    auto ws = std::make_unique<ix::WebSocket>();
    ws->setUrl(wsUrl.toStdString());
    ws->setPingInterval(20);
    ws->enableAutomaticReconnection();
    ws->setMinWaitBetweenReconnectionRetries(500);
    ws->setMaxWaitBetweenReconnectionRetries(5000);

    // `raw` stays valid for every callback: the object is only destroyed after stop() joined its thread.
    auto* raw = ws.get();
    ws->setOnMessageCallback([this, raw](const ix::WebSocketMessagePtr& msg) {
        switch (msg->type) {
            case ix::WebSocketMessageType::Open:
                handleOpen();
                break;
            case ix::WebSocketMessageType::Message:
                if (msg->binary) {
                    if (onBinary) onBinary(msg->str);
                } else {
                    handleText(*raw, msg->str);
                }
                break;
            case ix::WebSocketMessageType::Close:
                if (msg->closeInfo.code == 4401) forceTokenRefresh.store(true);
                {
                    const juce::ScopedLock sl(lock);
                    snapshot.online.clear();
                }
                setStatus(SignalingStatus::Reconnecting, juce::String(msg->closeInfo.reason));
                if (onMessage) onMessage(makeObject({ {"type", "_disconnected"} }));
                break;
            case ix::WebSocketMessageType::Error:
                setStatus(SignalingStatus::Reconnecting, "Can't reach server: " + juce::String(msg->errorInfo.reason));
                break;
            default:
                break;
        }
    });

    {
        const juce::ScopedLock sl(socketLock);
        socket = std::move(ws);
    }
    raw->start();
}

void SignalingClient::disconnect() {
    std::unique_ptr<ix::WebSocket> ws;
    {
        const juce::ScopedLock sl(socketLock);
        ws = std::move(socket);
    }
    if (ws != nullptr) ws->stop(); // joins the socket thread; no callbacks after this

    const juce::ScopedLock sl(lock);
    snapshot = {};
}

bool SignalingClient::send(const juce::var& message) {
    const auto text = juce::JSON::toString(message, true).toStdString();
    const juce::ScopedLock sl(socketLock);
    if (socket == nullptr || socket->getReadyState() != ix::ReadyState::Open) return false;
    return socket->sendText(text).success;
}

bool SignalingClient::isConnected() const {
    const juce::ScopedLock sl(lock);
    return snapshot.status == SignalingStatus::Connected;
}

SessionSnapshot SignalingClient::getSnapshot() const {
    const juce::ScopedLock sl(lock);
    return snapshot;
}

void SignalingClient::setStatus(SignalingStatus s, const juce::String& error) {
    const juce::ScopedLock sl(lock);
    // A hard failure (e.g. not a member) sticks until the next connect()
    if (snapshot.status == SignalingStatus::Failed && s == SignalingStatus::Reconnecting) return;
    snapshot.status = s;
    if (error.isNotEmpty()) snapshot.lastError = error;
}

void SignalingClient::handleOpen() {
    // Runs on the socket thread, so a blocking token refresh is fine here.
    const auto token = tokenProvider(forceTokenRefresh.exchange(false));
    if (token.isEmpty()) {
        setStatus(SignalingStatus::Failed, "Not signed in");
        return;
    }

    juce::String sessionId, daw;
    {
        const juce::ScopedLock sl(lock);
        sessionId = snapshot.sessionId;
        daw = dawName;
    }

    // The server processes messages in order, so auth + join can be sent back-to-back.
    send(makeObject({ {"type", "auth"}, {"token", token}, {"client", "plugin"}, {"daw", daw} }));
    send(makeObject({ {"type", "join_session"}, {"sessionId", sessionId}, {"daw", daw} }));
}

void SignalingClient::handleText(ix::WebSocket& ws, const std::string& text) {
    const auto msg = juce::JSON::parse(juce::String::fromUTF8(text.c_str(), (int) text.size()));
    if (!msg.isObject()) return;

    const auto type = msg["type"].toString();

    if (type == "session_joined") {
        const auto& s = msg["session"];
        const auto& r = msg["relay"];
        const juce::ScopedLock sl(lock);
        snapshot.status = SignalingStatus::Connected;
        snapshot.lastError = {};
        snapshot.connectionId = msg["connectionId"].toString();
        snapshot.sessionName = s["name"].toString();
        snapshot.inviteCode = s["inviteCode"].toString();
        snapshot.keySignature = s["keySignature"].toString();
        snapshot.bpm = static_cast<double>(s["bpm"]);
        snapshot.stunServer = msg["stunServer"].toString();
        if (r.isObject()) {
            snapshot.relay.host = r["host"].toString();
            snapshot.relay.port = static_cast<int>(r["port"]);
            snapshot.relay.token = r["token"].toString();
            snapshot.relay.expiresAt = static_cast<int64_t>(static_cast<double>(r["expiresAt"]));
        }
    } else if (type == "presence") {
        std::vector<PresenceEntry> online;
        if (auto* arr = msg["online"].getArray()) {
            for (const auto& p : *arr) {
                online.push_back({ p["connectionId"].toString(), p["userId"].toString(), p["userName"].toString(),
                                   p["client"].toString(), p["daw"].toString() });
            }
        }
        const juce::ScopedLock sl(lock);
        snapshot.online = std::move(online);
    } else if (type == "beatjam_state") {
        const auto& st = msg["state"];
        BeatJamInfo b;
        b.active = (bool) st["active"];
        b.status = st["status"].toString();
        b.startedBy = st["startedBy"].toString();
        b.bpm = (int) st["bpm"];
        b.error = st["error"].toString();
        if (auto* arr = st["prompts"].getArray())
            for (const auto& p : *arr) b.prompts.add(p["text"].toString());
        const juce::ScopedLock sl(lock);
        snapshot.beatJam = b;
    } else if (type == "session_tempo") {
        const juce::ScopedLock sl(lock);
        snapshot.bpm = static_cast<double>(msg["bpm"]);
        snapshot.lastTempoChangeBy = msg["byName"].toString();
    } else if (type == "auth_error") {
        forceTokenRefresh.store(true);
        setStatus(SignalingStatus::Reconnecting, "Session token rejected, refreshing...");
    } else if (type == "error") {
        const auto code = msg["code"].toString();
        if (code == "not_a_member" || code == "session_not_found") {
            setStatus(SignalingStatus::Failed, msg["message"].toString());
            ws.disableAutomaticReconnection();
            ws.close();
        } else {
            const juce::ScopedLock sl(lock);
            snapshot.lastError = msg["message"].toString();
        }
    }

    if (onMessage) onMessage(msg);
}

} // namespace downbeat
