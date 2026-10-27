# Example scene — films a tiny static page served from example-site/.
# Run it from the demo-recorder folder:
#   demo-recorder examples/example.scene.md --url http://localhost:8931 --audit
# (serve the site first:  python3 -m http.server 8931 --directory examples/example-site)

[go /] this little page loads in a blink.

[hover css:h1] the heading sits right at the top of the screen,

[click placeholder:Search things] click into the search field,

[type hello world] type a query into it,

[click button:Do it] and press the button — the message appears below.

[scrollto css:h2] now scroll down to the section at the bottom,

[scroll -2000 over 2] and glide back up to the top. that's the whole tour.
