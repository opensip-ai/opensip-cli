// Entry module for the sample Rust project.

mod util;

use util::{Greeter, helper};

fn entry(x: i32) -> String {
    let g = Greeter::new("hello");
    let msg = g.greet(x);
    helper(&msg)
}

fn unused() {
    println!("orphan");
}

fn main() {
    let result = entry(7);
    println!("{}", result);
}
