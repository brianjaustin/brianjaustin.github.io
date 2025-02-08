---
title: AO3's Journey from Paperclip to ActiveStorage
date: 2025-02-08
---

_Disclaimer: although I am a senior software development volunteer at Archive of Our Own (AO3), any opinions are solely my own and not reflective of AO3, the Organization for Transformative works, or my employer._

AO3 currently has three places where users can upload images:

1. Collection icons, as demonstrated by
   [https://archiveofourown.org/collections/yuletide](https://archiveofourown.org/collections/yuletide)
1. Pseudonym (pseud) icons, which are linked to users (the icon for the default
   pseud is also a user’s avatar on AO3)
1. Skin (theme) previews, as demonstrated by the
   [official Reversi skin](https://archiveofourown.org/skins/929)

Until recently, AO3 used a library called [paperclip](https://github.com/thoughtbot/paperclip)
to store these; sadly, it was
[officially deprecated in 2018](https://thoughtbot.com/blog/closing-the-trombone).
Around this time, AO3 migrated to [kt-paperclip](https://github.com/kreeti/kt-paperclip), a fork of
paperclip that is still maintained to this day. kt-paperclip served us well until we upgraded to Ruby
3.1, which introduced
[compatibility issues with how we stored our credentials](https://github.com/kreeti/kt-paperclip/pull/135).
We changed to use environment variables instead, but that added priority to the ticket in our backlog
to migrate to ActiveStorage.

Additionally, we had a couple problems that required moving attachments anyways, regardless of
whether we kept using kt-paperclip or migrated to ActiveStorage

- Collection icons and skin previews were stored in the same S3 path in production and staging,
  so changing the attachment in one environment would change the other as well… yikes!
- The Systems committee (of which I am also a member) wanted to shift our storage location,
  and S3 bucket, from a legacy shared account to environment- and project-specific AWS accounts.

## The code changes

Changing the application code was the least painful part of the process. Attachments are stored
differently in ActiveStorage than with paperclip (separate tables versus columns on the parent object),
so there is more risk of N+1 queries. Many of those we resolved, but a few we have left for later
because they were connected to existing questionable queries.

AO3 also resizes icons for display, which ActiveStorage
[handles this using vips](https://guides.rubyonrails.org/active_storage_overview.html#requirements).
Supporting this required installing libvips everywhere we run the code – test pipelines, Dockerfile,
and staging/production servers. That package is available from Debian’s default apt repositories
though, so not much extra effort.

### A caching side-note

AO3 uses CloudFlare for DDoS protection and caching. Another benefit we wanted from ActiveStorage
was using CloudFlare to cache images, helping us reduce our AWS bill for S3. The initial code
[configured rails_storage_proxy](https://github.com/otwcode/otwarchive/pull/4807/commits/0662741a06a430c2673da63cd368744b7713c5d0),
but we also needed to [change how icon URLs were generated](https://github.com/otwcode/otwarchive/pull/5009/files).
The latter _is_ documented for redirect mode, although I think
[the docs](https://guides.rubyonrails.org/active_storage_overview.html#proxy-mode) could do better
indicating that this is required for proxy mode as well.

## Copying icons

Once the code was ready, we had a slightly more complicated deploy process than normal. To avoid
adverse user experiences, we planned to

1. Deploy the code to a single server that did not get user traffic
1. Run scripts to copy all images to their new homes
1. Deploy the code to all the servers
1. Re-run the scripts to catch any images uploaded after the copy finished but before the new code
   was deployed

That went fine in our staging environment, and was relatively OK for collection and pseud icons in
production as well (although I suspect some performance issues we observed around that time were
related to running those copy scripts). Pseuds on production were another story: we have over 8 million
of them, which is well into silly numbers and makes running some queries Scary.

At the time, I was following a guide (I no longer remember where) that suggested a script like this
to move everything over

<script src="https://gist.github.com/brianjaustin/aba4eaffa07e312bc6100b6f0c121ce6.js"></script>

You might already see a few problems with that. Sadly for us, we initially did not.
Just a few minutes after starting that script, we saw CPU usage on our three primary database
servers spike to abnormal levels, and users started getting 503 errors.

{% image "./db_cpu_usage.png", "Graph of database CPU usage with two spikes to above 80% on all three servers" %}

Oh no. We stopped the script and started looking for why it was hammering the database so badly.

### What went wrong

The first thing we noticed was that the code above will touch records' `updated_at` timestamp
when an icon is attached, even though there is no user-facing change. Weird for users,
and not ideal adding an extra write to the database (partiularly in a table as big as `pseuds`).
That can be turned off easily enough by wrapping it with
[`Pseud.no_touching`](https://api.rubyonrails.org/classes/ActiveRecord/NoTouching/ClassMethods.html).

The second suspicious thing is the call to download the original icon, `URI.parse(icon_url)`.
That feels suspiciously like downloading a file while in an open database transaction: not good.

We tried a couple more versions of the copy script to adress the two issues above, and got a little
bit further (not much) before the database fell over again. At this point, I decided to get everything
possible out of the database. I re-wrote the script entirely to

1. Iterate over icons in our original S3 bucket, rather than rows in the `pseuds` table
1. Create an `ActiveStorage::Blob` and `ActiveStorage::Attachment` by hand, then upload the file
   manually to the new S3 bucket after the database work was done.

Here's what that looks like (the checksum calculation is copied directly from the ActiveStorage's
impementation):

<script src="https://gist.github.com/brianjaustin/d74eda0dcfd07d80bf26a475529179c1.js"></script>

Later, I also added an environment variable to control which prefixes in S3 were scanned,
so we could do batches in parallel. That took us down to under a week to copy over 6 million icons.

## Following up

I was hoping to rest and take a few weeks off now that this -- fairly annoying -- change was out
in the wild. Sadly not to be. We noticed that there were now millions of jobs in Resque's `default`
queue. Processing those made the database unhappy yet again. So we [turned off the ActiveStorage
analyze jobs](https://github.com/otwcode/otwarchive/pull/5028) (we don't need what they provide
for now, but we do need DB stability) and things were mostly happy again.

We also tried turning off the proxy endpoint for a bit due to suspected database connection leaks,
but that resulted in 500 errors due to some icons being attached but not in S3 (a consequence
of how the final copy sript worked), so we went back to using the proxy endpoint which still throws
errors but not in a way that totally breaks certain pages.

[james\_](https://github.com/zz9pzza), our tech lead on the Systems side and member of AD&T, also
added some code to separate ActiveStorage proxy endpoint requests from other requests in HAProxy,
and force a timeout of 5 seconds to avoid accidentally starving everything else when loading from
S3 takes awhile.

## Conclusion

I'm glad we have this checked off our list so we can focus on other time-sensitive projects
(like upcoming Ruby and Rails version upgrades). However, if you are happy with kt-paperclip
and not facing stability issues, I would not recommend doing this migration. It was quite a lot of
trouble for our -- fairly small -- SRE team, and so far the only big benefit has been caching
requests to S3 (which we were paying for each time before). If you do try this migration for yourself,
good luck and godspeed.

PRs from this process:

- [https://github.com/otwcode/otwarchive/pull/4807](https://github.com/otwcode/otwarchive/pull/4807)
- [https://github.com/otwcode/otwarchive/pull/5009](https://github.com/otwcode/otwarchive/pull/5009)
- [https://github.com/otwcode/otwarchive/pull/5015](https://github.com/otwcode/otwarchive/pull/5015)
- [https://github.com/otwcode/otwarchive/pull/5018](https://github.com/otwcode/otwarchive/pull/5018)
- [https://github.com/otwcode/otwarchive/pull/5028](https://github.com/otwcode/otwarchive/pull/5028)

_The programmers at AO3 can be contacted via otw-coders@transformativeworks.org, and our team of
SREs at systems@transformativeworks.org._
