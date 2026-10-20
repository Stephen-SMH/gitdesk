// The UI in ../dist is embedded (or, in debug builds, located) at compile time,
// so rebuild whenever `npm run build` changes it, including its first run.
fn main() {
    println!("cargo:rerun-if-changed=../dist");
}
