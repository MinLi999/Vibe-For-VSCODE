#!/bin/bash
# Prints a monotonically increasing CFBundleVersion (build number) for Sparkle.
#
# Sparkle compares CFBundleVersion, not CFBundleShortVersionString — a build number that
# doesn't strictly increase makes the updater report "you're up to date" even after a real
# release (see docs/SPARKLE.md pitfall #1). Rather than hand-incrementing an integer (easy to
# forget), this uses UTC "YYYYMMDDHHMM": it only goes up, needs no state, and works even
# before any appcast exists yet (first release has nothing to read "current version" from).
date -u +%Y%m%d%H%M
