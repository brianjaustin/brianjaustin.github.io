// This is based on https://github.com/11ty/eleventy-base-blog/blob/3ceaafc400dfa44001af2457d207ff25e0ca8010/eleventy.config.images.js.
// It can probably be removed (or heavily simplified) when I convert this to 11ty 3.x.
// (I had some compatibility issues related to CommonJS vs ESM with HTML base so not doing it yet.)

const path = require("path");
const eleventyImage = require("@11ty/eleventy-img");

function relativeToInputPath(inputPath, relativeFilePath) {
	let split = inputPath.split("/");
	split.pop();

	return path.resolve(split.join(path.sep), relativeFilePath);
}

function isFullUrl(url) {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

/** @param {import('@11ty/eleventy').UserConfig} eleventyConfig */
module.exports = (eleventyConfig) => {
	// Eleventy Image shortcode
	// https://www.11ty.dev/docs/plugins/image/
	eleventyConfig.addAsyncShortcode(
		"image",
		async function imageShortcode(src, alt, sizes) {
			// Full list of formats here: https://www.11ty.dev/docs/plugins/image/#output-formats
			const formats = ["webp", "jpeg", "auto"];
			let input;
			if (isFullUrl(src)) {
				input = src;
			} else {
				input = relativeToInputPath(this.page.inputPath, src);
			}

			let metadata = await eleventyImage(input, {
				widths: ["auto"],
				formats,
				outputDir: path.join(eleventyConfig.dir.output, "img"),
			});

			let imageAttributes = {
				alt,
				sizes,
				loading: "lazy",
				decoding: "async",
			};

			return eleventyImage.generateHTML(metadata, imageAttributes);
		},
	);
};
