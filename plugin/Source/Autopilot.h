#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <functional>
#include <map>

namespace downbeat {

/**
 * Developer aid for recording demo videos and UI tests: replays a script of UI actions on a timeline.
 * Only active when DOWNBEAT_AUTOPILOT=/path/to/script is set; never used by normal users.
 *
 * Script: one action per line, "<delay-ms> <command> [args...]"; '#' starts a comment.
 *   click <componentID>             presses a button (same code path as a mouse click)
 *   type <componentID> <text...>    replaces a text field's contents
 *   <custom> [args...]              any command registered with addCommand (e.g. note, preview)
 */
class Autopilot : private juce::Timer {
public:
    using Command = std::function<void(const juce::StringArray& args)>;

    Autopilot(juce::Component& rootComponent, const juce::File& script) : root(rootComponent) {
        juce::StringArray lines;
        lines.addLines(script.loadFileAsString());
        for (auto line : lines) {
            line = line.upToFirstOccurrenceOf("#", false, false).trim();
            if (line.isEmpty()) continue;
            auto tokens = juce::StringArray::fromTokens(line, " ", "\"");
            tokens.removeEmptyStrings();
            if (tokens.size() < 2) continue;
            steps.push_back({ tokens[0].getIntValue(), tokens[1], juce::StringArray(tokens.begin() + 2, tokens.size() - 2) });
        }
        log("loaded " + juce::String((int) steps.size()) + " steps from " + script.getFullPathName());
    }

    void addCommand(const juce::String& name, Command fn) { commands[name] = std::move(fn); }

    void start() {
        if (!steps.empty()) startTimer(juce::jmax(1, steps.front().delayMs));
    }

    static void log(const juce::String& message) {
        // stdout so a recording script can react (e.g. confirm the pairing code)
        std::printf("DOWNBEAT_AUTOPILOT %s\n", message.toRawUTF8());
        std::fflush(stdout);
    }

private:
    struct Step {
        int delayMs;
        juce::String command;
        juce::StringArray args;
    };

    void timerCallback() override {
        stopTimer();
        if (next >= steps.size()) return;
        run(steps[next++]);
        if (next < steps.size()) startTimer(juce::jmax(1, steps[next].delayMs));
        else log("done");
    }

    void run(const Step& s) {
        log("step " + s.command + " " + s.args.joinIntoString(" "));
        if (s.command == "click") {
            if (auto* b = dynamic_cast<juce::Button*>(find(root, s.args[0]))) b->triggerClick();
            else log("no button " + s.args[0]);
        } else if (s.command == "type") {
            if (auto* t = dynamic_cast<juce::TextEditor*>(find(root, s.args[0])))
                t->setText(juce::StringArray(s.args.begin() + 1, s.args.size() - 1).joinIntoString(" "), true);
            else log("no text field " + s.args[0]);
        } else if (auto it = commands.find(s.command); it != commands.end()) {
            it->second(s.args);
        } else {
            log("unknown command " + s.command);
        }
    }

    static juce::Component* find(juce::Component& c, const juce::String& id) {
        if (c.getComponentID() == id) return &c;
        for (auto* child : c.getChildren())
            if (auto* hit = find(*child, id)) return hit;
        return nullptr;
    }

    juce::Component& root;
    std::vector<Step> steps;
    size_t next{0};
    std::map<juce::String, Command> commands;
};

} // namespace downbeat
