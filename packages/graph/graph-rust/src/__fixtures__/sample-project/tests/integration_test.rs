// Integration test exercising the helper.

use sample_project::util::helper;

#[test]
fn helper_prepends_prefix() {
    assert_eq!(helper("ok"), "helper:ok");
}

#[test]
fn helper_handles_empty_string() {
    assert_eq!(helper(""), "helper:");
}
