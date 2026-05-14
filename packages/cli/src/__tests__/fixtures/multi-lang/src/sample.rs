// Sample Rust source for multi-language fitness checks.
fn parse_str(s: &str) -> i32 {
    s.parse().unwrap()
}

fn main() {
    let n = parse_str("42");
    println!("{}", n);
}
