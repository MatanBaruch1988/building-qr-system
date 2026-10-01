-- The demo account may scan every point, so listing it under "who may scan here" means nothing and only
-- confuses. Remove its assignments, but never from a point where it is the only one listed: with an empty
-- list a point is open to every provider, and this clean-up must not widen anyone's access.
delete from point_providers pp
 using providers d
 where pp.provider_id = d.id
   and d.is_demo
   and exists (
     select 1
       from point_providers o
       join providers op on op.id = o.provider_id
      where o.point_id = pp.point_id and not op.is_demo
   );
