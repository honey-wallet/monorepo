const { withXcodeProject } = require('expo/config-plugins');

// Expo's generated command substitution is unquoted, so a checkout containing
// spaces (such as "honey wallet") fails at the final iOS release bundling step.
module.exports = function withQuotedBundleScript(config) {
  return withXcodeProject(config, (config) => {
    const phases = config.modResults.hash.project.objects.PBXShellScriptBuildPhase;
    for (const phase of Object.values(phases)) {
      if (typeof phase !== 'object' || !phase.shellScript) continue;
      const script = JSON.parse(phase.shellScript);
      const command =
        "`\"$NODE_BINARY\" --print \"require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'\"`";
      if (!script.includes(command)) continue;
      phase.shellScript = JSON.stringify(
        script.replace(
          command,
          'REACT_NATIVE_XCODE_SCRIPT="$("$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'")"\n/bin/bash "$REACT_NATIVE_XCODE_SCRIPT"',
        ),
      );
    }
    return config;
  });
};
