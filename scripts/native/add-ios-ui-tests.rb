require 'fileutils'
require 'xcodeproj'

# Add an XCTest UI target only to the disposable Actions checkout. Production
# native source and the App target are not patched to fabricate a test result.
root = File.expand_path('../..', __dir__)
project_path = File.join(root, 'ios/App/App.xcodeproj')
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'App' }
raise 'The production App target is missing' unless app
raise 'Refusing to replace an existing UI target' if project.targets.any? { |target| target.name == 'TCGHubSmoke' }
test_dir = File.join(root, 'ios/App/TCGHubSmoke')
FileUtils.mkdir_p(test_dir)
FileUtils.cp(File.join(__dir__, 'TCGHubSmokeTests.swift'), test_dir)
target = project.new_target(:ui_test_bundle, 'TCGHubSmoke', :ios, '15.0', nil, :swift)
group = project.main_group.new_group('TCGHubSmoke', 'TCGHubSmoke')
source = group.new_file('TCGHubSmokeTests.swift')
target.source_build_phase.add_file_reference(source)
target.add_dependency(app)
target.build_configurations.each do |configuration|
  configuration.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'kr.tcghub.app.SmokeTests'
  configuration.build_settings['TEST_TARGET_NAME'] = 'App'
  configuration.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  configuration.build_settings['SWIFT_VERSION'] = '5.0'
  configuration.build_settings['SUPPORTED_PLATFORMS'] = 'iphonesimulator'
  configuration.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  configuration.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  configuration.build_settings['DEVELOPMENT_TEAM'] = ''
end
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
attributes[target.uuid] = { 'TestTargetID' => app.uuid }
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, target, :launch_target => app)
scheme.save_as(project_path, 'TCGHubSmoke', true)
puts 'Added isolated XCTest UI target TCGHubSmoke for the unchanged App target.'
